import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});
vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

const hasChargeablePaymentMethod = vi.fn();
vi.mock("../../src/lib/chargeable-method", () => ({
  hasChargeablePaymentMethod: (...a: unknown[]) => hasChargeablePaymentMethod(...a),
}));

const createCustomer = vi.fn();
vi.mock("../../src/lib/revolut-client", () => ({
  createCustomer: (...a: unknown[]) => createCustomer(...a),
}));

import {
  readRollout,
  rolloutBucket,
  selectAcquirerForCheckout,
  writeRollout,
} from "../../src/lib/acquirer-rollout";

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearQueues();
  dbMock.clearCaptured();
  hasChargeablePaymentMethod.mockResolvedValue(false);
  createCustomer.mockResolvedValue({ id: "cus-rev-new" });
});

/** An org whose bucket is below `n`, found by trying ids. */
function orgInBucketBelow(n: number): string {
  for (let i = 0; i < 500; i++) {
    const id = `org-${i}`;
    if (rolloutBucket(id) < n) return id;
  }
  throw new Error("no org found");
}

function orgInBucketAtLeast(n: number): string {
  for (let i = 0; i < 500; i++) {
    const id = `org-${i}`;
    if (rolloutBucket(id) >= n) return id;
  }
  throw new Error("no org found");
}

describe("the rollout row", () => {
  it("reads 0% when nobody has set one — every org stays where it is", async () => {
    dbMock.queueSelect("acquirer_rollout", []);
    expect(await readRollout()).toEqual({ acquirer: "stripe", percent: 0 });
  });

  it("throws on a row naming an acquirer we do not know, rather than routing money there", async () => {
    dbMock.queueSelect("acquirer_rollout", [{ acquirer: "adyen", percent: 50 }]);
    await expect(readRollout()).rejects.toThrow(/unknown acquirer/i);
  });

  it("writes one row, so setting it again replaces rather than accumulates", async () => {
    await writeRollout({ acquirer: "revolut", percent: 25 });
    expect(dbMock.lastInsertValues("acquirer_rollout")).toMatchObject({
      id: 1,
      acquirer: "revolut",
      percent: 25,
    });
  });
});

describe("rolloutBucket", () => {
  it("is stable for an org, so a buyer who comes back meets the same acquirer", () => {
    expect(rolloutBucket("org-abc")).toBe(rolloutBucket("org-abc"));
    expect(rolloutBucket("org-abc")).toBeGreaterThanOrEqual(0);
    expect(rolloutBucket("org-abc")).toBeLessThan(100);
  });

  it("spreads orgs across the range rather than piling them in one bucket", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(rolloutBucket(`org-${i}`));
    expect(seen.size).toBeGreaterThan(50);
  });
});

describe("selectAcquirerForCheckout", () => {
  it("leaves every org on Stripe while the rollout is off, and asks the acquirer nothing", async () => {
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("acquirer_rollout", []);

    expect(await selectAcquirerForCheckout("org-1")).toEqual({
      acquirer: "stripe",
      customerId: null,
      pinned: false,
    });
    expect(hasChargeablePaymentMethod).not.toHaveBeenCalled();
    expect(createCustomer).not.toHaveBeenCalled();
    expect(dbMock.lastInsertValues("org_acquirers")).toBeUndefined();
  });

  it("selects a NEW org when its bucket falls inside the share", async () => {
    const orgId = orgInBucketBelow(50);
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("acquirer_rollout", [{ acquirer: "revolut", percent: 50 }]);
    dbMock.queueSelect("customers", [{ email: "buyer@example.com", name: "Buyer" }]);

    expect(await selectAcquirerForCheckout(orgId)).toEqual({
      acquirer: "revolut",
      customerId: "cus-rev-new",
      pinned: true,
    });
    expect(createCustomer).toHaveBeenCalledWith({
      email: "buyer@example.com",
      full_name: "Buyer",
    });
    expect(dbMock.lastInsertValues("org_acquirers")).toMatchObject({
      orgId,
      acquirer: "revolut",
      acquirerCustomerId: "cus-rev-new",
    });
  });

  it("leaves an org outside the share alone", async () => {
    const orgId = orgInBucketAtLeast(10);
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("acquirer_rollout", [{ acquirer: "revolut", percent: 10 }]);

    const pin = await selectAcquirerForCheckout(orgId);
    expect(pin.acquirer).toBe("stripe");
    expect(createCustomer).not.toHaveBeenCalled();
  });

  // The invariant this whole feature is gated on.
  it("NEVER moves an org that already has a saved payment method, even at 100%", async () => {
    // Its card lives with the acquirer it is on and cannot be charged through
    // the other one, so moving it would leave its next automatic reload failing
    // against an acquirer that has never seen the card — silently, because
    // nothing about the pin itself fails.
    hasChargeablePaymentMethod.mockResolvedValue(true);
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("acquirer_rollout", [{ acquirer: "revolut", percent: 100 }]);

    const pin = await selectAcquirerForCheckout(orgInBucketBelow(100));

    expect(pin).toEqual({ acquirer: "stripe", customerId: null, pinned: false });
    expect(createCustomer).not.toHaveBeenCalled();
    expect(dbMock.lastInsertValues("org_acquirers")).toBeUndefined();
  });

  it("propagates when the acquirer cannot be asked, rather than reading it as 'no card'", async () => {
    // "We could not ask" and "there is no card" are different answers, and only
    // one of them makes a move safe.
    hasChargeablePaymentMethod.mockRejectedValue(new Error("acquirer unreachable"));
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("acquirer_rollout", [{ acquirer: "revolut", percent: 100 }]);

    await expect(
      selectAcquirerForCheckout(orgInBucketBelow(100))
    ).rejects.toThrow(/unreachable/);
    expect(dbMock.lastInsertValues("org_acquirers")).toBeUndefined();
  });

  it("leaves an org that is already pinned exactly where it is", async () => {
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);

    expect(await selectAcquirerForCheckout("org-1")).toEqual({
      acquirer: "revolut",
      customerId: "cus-rev-1",
      pinned: true,
    });
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it("sends everybody back to the default the moment the share is set to 0", async () => {
    const orgId = orgInBucketBelow(100);
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("acquirer_rollout", [{ acquirer: "revolut", percent: 0 }]);

    expect((await selectAcquirerForCheckout(orgId)).acquirer).toBe("stripe");
    expect(createCustomer).not.toHaveBeenCalled();
  });
});
