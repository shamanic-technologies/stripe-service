import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock, stripeMock, runsMock, keyMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeDbMock, makeStripeMock } = require("../helpers/mocks-factory.cjs");
  const stripe = makeStripeMock(vi);
  stripe.balanceTransactions = { retrieve: vi.fn() };
  return {
    dbMock: makeDbMock(vi),
    stripeMock: stripe,
    runsMock: {
      createPlatformRun: vi.fn(),
      addPlatformRunCost: vi.fn(),
      updatePlatformRunStatus: vi.fn(),
    },
    keyMock: {
      getKeySource: vi.fn(),
    },
  };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));
vi.mock("../../src/lib/runs-client", () => runsMock);
vi.mock("../../src/lib/key-client", () => ({
  getKeySource: keyMock.getKeySource,
  resolvePlatformKey: vi.fn(),
  getDecryptedStripeKey: vi.fn(),
}));

import { declareFeesForEvent } from "../../src/lib/declare-fees";

beforeEach(() => {
  vi.resetAllMocks();
  keyMock.getKeySource.mockResolvedValue({
    provider: "stripe",
    orgId: "org_default",
    keySource: "platform",
    isDefault: true,
  });
  runsMock.createPlatformRun.mockResolvedValue({
    id: "run_default",
    organizationId: null,
    userId: null,
    serviceName: "stripe-service",
    taskName: "default",
    status: "started",
    idempotencyKey: null,
  });
  runsMock.addPlatformRunCost.mockResolvedValue(undefined);
  runsMock.updatePlatformRunStatus.mockResolvedValue(undefined);
});

describe("declareFeesForEvent — charge.succeeded", () => {
  it("declares stripe-processing-fee with resolved org and keySource", async () => {
    dbMock.queueSelect("customers", [{ orgId: "org-acme" }]);
    keyMock.getKeySource.mockResolvedValueOnce({
      provider: "stripe",
      orgId: "org-acme",
      keySource: "org",
      isDefault: false,
    });
    stripeMock.balanceTransactions.retrieve.mockResolvedValueOnce({
      id: "txn_processing",
      fee: 290,
    });
    runsMock.createPlatformRun.mockResolvedValueOnce({
      id: "run_processing",
    });

    const event = {
      id: "evt_charge_1",
      type: "charge.succeeded",
      data: {
        object: {
          id: "ch_1",
          object: "charge",
          customer: "cus_acme",
          balance_transaction: "txn_processing",
        },
      },
    } as never;

    await declareFeesForEvent(event, stripeMock as never);

    expect(stripeMock.balanceTransactions.retrieve).toHaveBeenCalledWith(
      "txn_processing"
    );
    expect(keyMock.getKeySource).toHaveBeenCalledWith("org-acme", "stripe");
    expect(runsMock.createPlatformRun).toHaveBeenCalledWith({
      taskName: "charge.succeeded",
      idempotencyKey: "stripe:txn_processing",
      orgId: "org-acme",
    });
    expect(runsMock.addPlatformRunCost).toHaveBeenCalledWith({
      runId: "run_processing",
      costName: "stripe-processing-fee",
      costSource: "org",
      quantity: 290,
      idempotencyKey: "stripe:txn_processing",
    });
    expect(runsMock.updatePlatformRunStatus).toHaveBeenCalledWith({
      runId: "run_processing",
      status: "completed",
    });
  });

  it("uses platform costSource and omits orgId when customer has no org mapping", async () => {
    dbMock.queueSelect("customers", []);
    stripeMock.balanceTransactions.retrieve.mockResolvedValueOnce({
      id: "txn_orphan",
      fee: 100,
    });
    runsMock.createPlatformRun.mockResolvedValueOnce({ id: "run_orphan" });

    const event = {
      id: "evt_charge_orphan",
      type: "charge.succeeded",
      data: {
        object: {
          id: "ch_orphan",
          customer: "cus_orphan",
          balance_transaction: "txn_orphan",
        },
      },
    } as never;

    await declareFeesForEvent(event, stripeMock as never);

    expect(keyMock.getKeySource).not.toHaveBeenCalled();
    expect(runsMock.createPlatformRun).toHaveBeenCalledWith({
      taskName: "charge.succeeded",
      idempotencyKey: "stripe:txn_orphan",
      orgId: null,
    });
    expect(runsMock.addPlatformRunCost).toHaveBeenCalledWith(
      expect.objectContaining({ costSource: "platform" })
    );
  });

  it("skips declaration when fee is zero", async () => {
    dbMock.queueSelect("customers", [{ orgId: "org-acme" }]);
    stripeMock.balanceTransactions.retrieve.mockResolvedValueOnce({
      id: "txn_zero",
      fee: 0,
    });

    const event = {
      id: "evt_zero",
      type: "charge.succeeded",
      data: {
        object: {
          id: "ch_zero",
          customer: "cus_acme",
          balance_transaction: "txn_zero",
        },
      },
    } as never;

    await declareFeesForEvent(event, stripeMock as never);

    expect(runsMock.createPlatformRun).not.toHaveBeenCalled();
  });

  it("skips when balance_transaction is missing", async () => {
    const event = {
      id: "evt_no_bt",
      type: "charge.succeeded",
      data: {
        object: {
          id: "ch_no_bt",
          customer: "cus_x",
          balance_transaction: null,
        },
      },
    } as never;

    await declareFeesForEvent(event, stripeMock as never);

    expect(stripeMock.balanceTransactions.retrieve).not.toHaveBeenCalled();
    expect(runsMock.createPlatformRun).not.toHaveBeenCalled();
  });
});

describe("declareFeesForEvent — charge.refunded", () => {
  it("declares one refund-fee cost per refund in refunds.data", async () => {
    dbMock.queueSelect("customers", [{ orgId: "org-acme" }]);
    dbMock.queueSelect("customers", [{ orgId: "org-acme" }]);
    keyMock.getKeySource.mockResolvedValue({
      provider: "stripe",
      orgId: "org-acme",
      keySource: "platform",
      isDefault: true,
    });
    stripeMock.balanceTransactions.retrieve
      .mockResolvedValueOnce({ id: "txn_refund_1", fee: 30 })
      .mockResolvedValueOnce({ id: "txn_refund_2", fee: 30 });
    runsMock.createPlatformRun
      .mockResolvedValueOnce({ id: "run_refund_1" })
      .mockResolvedValueOnce({ id: "run_refund_2" });

    const event = {
      id: "evt_refunded",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_refunded",
          customer: "cus_acme",
          refunds: {
            data: [
              { id: "re_1", balance_transaction: "txn_refund_1" },
              { id: "re_2", balance_transaction: "txn_refund_2" },
            ],
          },
        },
      },
    } as never;

    await declareFeesForEvent(event, stripeMock as never);

    expect(runsMock.createPlatformRun).toHaveBeenCalledTimes(2);
    expect(runsMock.addPlatformRunCost).toHaveBeenCalledTimes(2);
    expect(runsMock.addPlatformRunCost.mock.calls[0][0]).toMatchObject({
      runId: "run_refund_1",
      costName: "stripe-refund-fee",
      idempotencyKey: "stripe:txn_refund_1",
      quantity: 30,
    });
    expect(runsMock.addPlatformRunCost.mock.calls[1][0]).toMatchObject({
      runId: "run_refund_2",
      costName: "stripe-refund-fee",
      idempotencyKey: "stripe:txn_refund_2",
    });
  });
});

describe("declareFeesForEvent — charge.dispute.created", () => {
  it("declares stripe-dispute-fee using the dispute-type BT", async () => {
    dbMock.queueSelect("customers", [{ orgId: "org-acme" }]);
    stripeMock.balanceTransactions.retrieve.mockResolvedValueOnce({
      id: "txn_dispute",
      fee: 1500,
    });
    runsMock.createPlatformRun.mockResolvedValueOnce({ id: "run_dispute" });

    const event = {
      id: "evt_dispute",
      type: "charge.dispute.created",
      data: {
        object: {
          id: "dp_1",
          object: "dispute",
          charge: { id: "ch_disputed", customer: "cus_acme" },
          balance_transactions: [{ id: "txn_dispute", type: "dispute" }],
        },
      },
    } as never;

    await declareFeesForEvent(event, stripeMock as never);

    expect(runsMock.addPlatformRunCost).toHaveBeenCalledWith(
      expect.objectContaining({
        costName: "stripe-dispute-fee",
        quantity: 1500,
        idempotencyKey: "stripe:txn_dispute",
      })
    );
  });
});

describe("declareFeesForEvent — payout.failed", () => {
  it("declares stripe-payout-failure-fee with orgId=null and costSource=platform", async () => {
    stripeMock.balanceTransactions.retrieve.mockResolvedValueOnce({
      id: "txn_payout",
      fee: 400,
    });
    runsMock.createPlatformRun.mockResolvedValueOnce({ id: "run_payout" });

    const event = {
      id: "evt_payout",
      type: "payout.failed",
      data: {
        object: {
          id: "po_1",
          object: "payout",
          balance_transaction: "txn_payout",
        },
      },
    } as never;

    await declareFeesForEvent(event, stripeMock as never);

    expect(dbMock.db.select).not.toHaveBeenCalled();
    expect(keyMock.getKeySource).not.toHaveBeenCalled();
    expect(runsMock.createPlatformRun).toHaveBeenCalledWith({
      taskName: "payout.failed",
      idempotencyKey: "stripe:txn_payout",
      orgId: null,
    });
    expect(runsMock.addPlatformRunCost).toHaveBeenCalledWith(
      expect.objectContaining({
        costName: "stripe-payout-failure-fee",
        costSource: "platform",
      })
    );
  });
});

describe("declareFeesForEvent — error handling", () => {
  it("patches run status=failed when cost write fails, then re-throws", async () => {
    dbMock.queueSelect("customers", [{ orgId: "org-acme" }]);
    stripeMock.balanceTransactions.retrieve.mockResolvedValueOnce({
      id: "txn_err",
      fee: 290,
    });
    runsMock.createPlatformRun.mockResolvedValueOnce({ id: "run_err" });
    runsMock.addPlatformRunCost.mockRejectedValueOnce(
      new Error("422 Unknown cost name")
    );

    const event = {
      id: "evt_err",
      type: "charge.succeeded",
      data: {
        object: {
          id: "ch_err",
          customer: "cus_acme",
          balance_transaction: "txn_err",
        },
      },
    } as never;

    await expect(
      declareFeesForEvent(event, stripeMock as never)
    ).rejects.toThrow("422 Unknown cost name");
    expect(runsMock.updatePlatformRunStatus).toHaveBeenCalledWith({
      runId: "run_err",
      status: "failed",
    });
  });

  it("propagates key-service errors before any runs-service call", async () => {
    dbMock.queueSelect("customers", [{ orgId: "org-acme" }]);
    stripeMock.balanceTransactions.retrieve.mockResolvedValueOnce({
      id: "txn_keyerr",
      fee: 290,
    });
    keyMock.getKeySource.mockRejectedValueOnce(new Error("key-service down"));

    const event = {
      id: "evt_keyerr",
      type: "charge.succeeded",
      data: {
        object: {
          id: "ch_keyerr",
          customer: "cus_acme",
          balance_transaction: "txn_keyerr",
        },
      },
    } as never;

    await expect(
      declareFeesForEvent(event, stripeMock as never)
    ).rejects.toThrow("key-service down");
    expect(runsMock.createPlatformRun).not.toHaveBeenCalled();
  });
});

describe("declareFeesForEvent — non-fee events", () => {
  it("returns early for customer.created", async () => {
    const event = {
      id: "evt_cust",
      type: "customer.created",
      data: { object: { id: "cus_1" } },
    } as never;

    await declareFeesForEvent(event, stripeMock as never);

    expect(stripeMock.balanceTransactions.retrieve).not.toHaveBeenCalled();
    expect(runsMock.createPlatformRun).not.toHaveBeenCalled();
  });

  it("returns early for payment_intent.succeeded", async () => {
    const event = {
      id: "evt_pi",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_1" } },
    } as never;

    await declareFeesForEvent(event, stripeMock as never);

    expect(runsMock.createPlatformRun).not.toHaveBeenCalled();
  });
});
