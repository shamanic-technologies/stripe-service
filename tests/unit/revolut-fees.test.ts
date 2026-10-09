import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});
vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

const runsMock = vi.hoisted(() => ({
  createPlatformRun: vi.fn(),
  addPlatformRunCost: vi.fn(),
  updatePlatformRunStatus: vi.fn(),
}));
vi.mock("../../src/lib/runs-client", () => runsMock);

import {
  declarePendingRevolutFees,
  REVOLUT_FEE_COST_NAME,
} from "../../src/lib/revolut-fees";

function order(id: string, orgId: string, fee: number, currency = "USD") {
  return {
    id,
    orgId,
    feeAmount: fee,
    rawJson: { payments: [{ fees: [{ type: "acquiring", amount: fee, currency }] }] },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearQueues();
  runsMock.createPlatformRun.mockResolvedValue({ id: "run_1" });
  runsMock.addPlatformRunCost.mockResolvedValue(undefined);
  runsMock.updatePlatformRunStatus.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("declarePendingRevolutFees", () => {
  it("charges each completed payment's fee to its org, once", async () => {
    dbMock.queueSelect("revolut_orders", [order("ord-1", "org-a", 28)]);

    expect(await declarePendingRevolutFees()).toBe(1);

    expect(runsMock.createPlatformRun).toHaveBeenCalledWith({
      taskName: "revolut.payment.completed",
      idempotencyKey: "revolut:ord-1",
      orgId: "org-a",
    });
    expect(runsMock.addPlatformRunCost).toHaveBeenCalledWith({
      runId: "run_1",
      costName: REVOLUT_FEE_COST_NAME,
      costSource: "platform",
      quantity: 28,
      idempotencyKey: "revolut:ord-1",
    });
    expect(runsMock.updatePlatformRunStatus).toHaveBeenCalledWith({
      runId: "run_1",
      status: "completed",
    });
    expect(dbMock.db.update).toHaveBeenCalledTimes(1);
  });

  it("nothing pending declares nothing", async () => {
    expect(await declarePendingRevolutFees()).toBe(0);
    expect(runsMock.createPlatformRun).not.toHaveBeenCalled();
  });

  it("a non-USD fee is left undeclared and loud, and does not block the others", async () => {
    dbMock.queueSelect("revolut_orders", [
      order("ord-eur", "org-a", 30, "EUR"),
      order("ord-2", "org-b", 25),
    ]);

    expect(await declarePendingRevolutFees()).toBe(1);
    expect(runsMock.createPlatformRun).toHaveBeenCalledTimes(1);
    expect(runsMock.createPlatformRun.mock.calls[0][0].orgId).toBe("org-b");
    expect(console.error).toHaveBeenCalled();
  });

  it("a runs-service failure leaves the payment undeclared (not stamped) and marks the run failed", async () => {
    dbMock.queueSelect("revolut_orders", [order("ord-1", "org-a", 28)]);
    runsMock.addPlatformRunCost.mockRejectedValue(new Error("422 Unknown cost name"));

    expect(await declarePendingRevolutFees()).toBe(0);
    expect(runsMock.updatePlatformRunStatus).toHaveBeenCalledWith({
      runId: "run_1",
      status: "failed",
    });
    expect(dbMock.db.update).not.toHaveBeenCalled();
  });
});
