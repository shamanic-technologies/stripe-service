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

import {
  buildCardSetup,
  REVOLUT_SDK_SCRIPT_URL,
  VERIFICATION_AMOUNT,
} from "../../src/lib/card-setup";

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

    // What the browser gets, and NOTHING else. The SDK is initialised with the
    // ORDER's public token — verified against @revolut/checkout 1.1.25, whose
    // loader documents its first argument as the `public_id` of the created
    // order. No merchant key is on this path: the publishable key belongs to
    // the entry points that cannot save a card, so handing it over would be
    // shipping a credential the flow has no use for.
    expect(await buildCardSetup(base)).toEqual({
      object: "card_setup",
      mode: "embedded_widget",
      script_url: REVOLUT_SDK_SCRIPT_URL,
      environment: "prod",
      token: "tok-1",
      // Without this the card is stored for the customer's own checkouts and
      // cannot be charged off-session — which is the entire purpose.
      save_payment_method_for: "merchant",
    });
    expect(hostedSession).not.toHaveBeenCalled();
  });

  it("AUTHORISES without capturing, so changing a card costs nothing", async () => {
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);
    createOrder.mockResolvedValue({ id: "ord-1", token: "tok-1" });

    await buildCardSetup(base);

    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        capture_mode: "manual",
        amount: VERIFICATION_AMOUNT,
        customerId: "cus-rev-1",
      })
    );
  });

  it("needs no amount from the caller — updating a card is not a purchase", async () => {
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);
    createOrder.mockResolvedValue({ id: "ord-1", token: "tok-1" });

    await expect(buildCardSetup(base)).resolves.toMatchObject({
      mode: "embedded_widget",
    });
  });

  it("marks the order so the hold can be found and released later", async () => {
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);
    createOrder.mockResolvedValue({ id: "ord-1", token: "tok-1" });

    await buildCardSetup(base);

    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ purpose: "card-setup" }),
      })
    );
  });

  it("attaches the customer AND asks for the card to be saved for merchant use", async () => {
    // The order used to be created with `customer_id`, which is not a field on
    // that endpoint: it was dropped in silence and the order belonged to
    // nobody, so there was never anywhere for a card to be saved. Probed
    // against the live API on 2026-09-07 — `customer: { id }` is echoed back,
    // `customer_id` is not. That is why the save flag looked like it did
    // nothing, and why both are sent now.
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);
    createOrder.mockResolvedValue({ id: "ord-1", token: "tok-1" });

    await buildCardSetup(base);

    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cus-rev-1",
        save_payment_method_for: "merchant",
      })
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

  it("refuses a descriptor the browser could not mount", async () => {
    // A token-less descriptor would fail inside the customer's browser, where
    // nobody of ours can read the reason.
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);
    createOrder.mockResolvedValue({ id: "ord-1" });

    await expect(buildCardSetup(base)).rejects.toThrow(/no order token/i);
  });
});
