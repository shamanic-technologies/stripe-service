import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});
vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

import {
  resolveAcquirer,
  pinAcquirer,
  unpinAcquirer,
  DEFAULT_ACQUIRER,
} from "../../src/lib/acquirer";

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearQueues();
  dbMock.clearCaptured();
});

describe("resolveAcquirer", () => {
  it("defaults to Stripe for an org that was never pinned", async () => {
    dbMock.queueSelect("org_acquirers", []);
    expect(await resolveAcquirer("org-1")).toEqual({
      acquirer: "stripe",
      customerId: null,
    });
    expect(DEFAULT_ACQUIRER).toBe("stripe");
  });

  it("returns the pin and the acquirer's own customer id", async () => {
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);
    expect(await resolveAcquirer("org-1")).toEqual({
      acquirer: "revolut",
      customerId: "cus-rev-1",
    });
  });

  it("throws on an unreadable pin rather than silently charging the default", async () => {
    // Falling back to Stripe here would put the money through the wrong
    // acquirer while the customer's saved card lives on the other one.
    dbMock.queueSelect("org_acquirers", [{ acquirer: "adyen", customerId: null }]);
    await expect(resolveAcquirer("org-1")).rejects.toThrow(/unknown acquirer/i);
  });
});

describe("pinAcquirer", () => {
  it("pins an org that has never been pinned", async () => {
    dbMock.queueSelect("org_acquirers", []);
    await pinAcquirer({ orgId: "org-1", acquirer: "revolut", customerId: "cus-rev-1" });
    expect(dbMock.lastInsertValues("org_acquirers")).toMatchObject({
      orgId: "org-1",
      acquirer: "revolut",
      acquirerCustomerId: "cus-rev-1",
    });
  });

  it("REFUSES to move an org that already has a customer on the other acquirer", async () => {
    // A saved card cannot move between acquirers. Flipping the pin would leave
    // the org uncharge-able while its dashboard still shows a card on file.
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "stripe", customerId: "cus_stripe_1" },
    ]);
    await expect(
      pinAcquirer({ orgId: "org-1", acquirer: "revolut" })
    ).rejects.toThrow(/cannot move between them/i);
    expect(dbMock.lastInsertValues("org_acquirers")).toBeUndefined();
  });

  it("allows re-pinning when no customer was ever established", async () => {
    dbMock.queueSelect("org_acquirers", [{ acquirer: "stripe", customerId: null }]);
    await pinAcquirer({ orgId: "org-1", acquirer: "revolut", customerId: "cus-rev-1" });
    expect(dbMock.lastInsertValues("org_acquirers")).toMatchObject({
      acquirer: "revolut",
    });
  });

  it("keeps the existing customer id when the call omits one", async () => {
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);
    await pinAcquirer({ orgId: "org-1", acquirer: "revolut" });
    expect(dbMock.lastInsertValues("org_acquirers").acquirerCustomerId).toBe("cus-rev-1");
  });
});

describe("unpinAcquirer", () => {
  it("deletes the pin so the org reads as one that was never pinned", async () => {
    // Absent means Stripe, so removing the row IS "back to the default" — the
    // org ends up byte-identical to one that never moved, rather than carrying
    // a row that says the same thing a second way.
    await unpinAcquirer("org-1");
    expect(dbMock.db.delete).toHaveBeenCalled();
  });
});
