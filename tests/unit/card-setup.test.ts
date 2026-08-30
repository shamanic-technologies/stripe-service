import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});
vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));
const createOrder = vi.fn();
vi.mock("../../src/lib/revolut-client", () => ({
  createOrder: (...a: unknown[]) => createOrder(...a),
}));
vi.mock("../../src/lib/key-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/key-client")>();
  return { ...actual, resolvePlatformKey: vi.fn().mockResolvedValue({ key: "pk_test" }) };
});

import { buildCardSetup, CardSetupNeedsAmount } from "../../src/lib/card-setup";

const hostedSession = vi.fn().mockResolvedValue("https://portal.example/session");

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearQueues();
  hostedSession.mockResolvedValue("https://portal.example/session");
});

const base = {
  orgId: "org-1",
  returnUrl: "https://dashboard.example/billing",
  hostedSession,
  defaultCustomerId: "cus_stripe_1",
  amount: 50000,
  currency: "USD",
};

describe("buildCardSetup", () => {
  it("describes a hosted redirect for the default acquirer", async () => {
    dbMock.queueSelect("org_acquirers", []);
    expect(await buildCardSetup(base)).toEqual({
      object: "card_setup",
      mode: "hosted_redirect",
      url: "https://portal.example/session",
    });
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("describes an embedded widget for an acquirer with no portal", async () => {
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);
    createOrder.mockResolvedValue({ id: "ord-1", token: "tok-1" });

    expect(await buildCardSetup(base)).toEqual({
      object: "card_setup",
      mode: "embedded_widget",
      public_key: "pk_test",
      token: "tok-1",
      // Without this the card is stored for the customer's own checkouts and
      // cannot be charged off-session — which is the entire purpose.
      save_payment_method_for: "merchant",
    });
    expect(hostedSession).not.toHaveBeenCalled();
  });

  it("creates the order for the amount the customer is actually paying", async () => {
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);
    createOrder.mockResolvedValue({ id: "ord-1", token: "tok-1" });

    await buildCardSetup(base);

    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 50000, customer_id: "cus-rev-1" })
    );
  });

  it("refuses without an amount, because that acquirer cannot store a card for free", async () => {
    // A zero-amount order is ACCEPTED at create and then cannot be paid: the
    // widget fails with a bare "Transaction failed" and the order sits pending
    // with no payment attempt recorded. Verified in production.
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);

    await expect(
      buildCardSetup({ ...base, amount: undefined })
    ).rejects.toBeInstanceOf(CardSetupNeedsAmount);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("still needs no amount for an acquirer whose portal stores a card itself", async () => {
    dbMock.queueSelect("org_acquirers", []);
    const out = await buildCardSetup({ ...base, amount: undefined });
    expect(out.mode).toBe("hosted_redirect");
  });

  it("does NOT put the save flag on the order, because that API drops it silently", async () => {
    // Verified against production: a real card paid a real order carrying this
    // flag and no method was saved. It only takes effect in the browser SDK.
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);
    createOrder.mockResolvedValue({ id: "ord-1", token: "tok-1" });

    await buildCardSetup(base);

    expect(createOrder).toHaveBeenCalledWith(
      expect.not.objectContaining({ save_payment_method_for: expect.anything() })
    );
  });

  it("refuses when the org has no customer on its acquirer", async () => {
    dbMock.queueSelect("org_acquirers", [{ acquirer: "revolut", customerId: null }]);
    await expect(buildCardSetup(base)).rejects.toThrow(/no acquirer customer/i);

    dbMock.queueSelect("org_acquirers", []);
    await expect(
      buildCardSetup({ ...base, defaultCustomerId: null })
    ).rejects.toThrow(/no customer/i);
  });
});
