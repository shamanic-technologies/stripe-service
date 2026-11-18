import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

vi.mock("../../src/lib/event-processor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/event-processor")>();
  return {
    ...actual,
    recordApiSnapshot: vi.fn(async () => {}),
    resolveOrgId: vi.fn(async (m: string | null) => m ?? "org_a"),
  };
});

const clientMock = vi.hoisted(() => ({ getUserById: vi.fn() }));
vi.mock("../../src/lib/client-service-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/client-service-client")>()),
  getUserById: clientMock.getUserById,
}));

import {
  adoptPayerForEvent,
  CARD_UPDATE_OPENER_MAX_AGE_MS,
  isPayerIdentityEvent,
  showOpenerOnCustomer,
} from "../../src/lib/payer-email";
import { recordApiSnapshot } from "../../src/lib/event-processor";

const CREATOR = "creator@agency.com";
const CLIENT = "client@acme.com";

function makeStripe(currentEmail: string | null = CREATOR, currentName: string | null = null) {
  return {
    paymentMethods: {
      list: vi.fn(async () => ({ data: [], has_more: false })),
      update: vi.fn(async () => ({})),
    },
    customers: {
      retrieve: vi.fn(async () => ({ id: "cus_1", object: "customer", email: currentEmail, name: currentName })),
      update: vi.fn(async (_id: string, p: { email?: string }) => ({
        id: "cus_1",
        object: "customer",
        email: p.email ?? currentEmail,
        metadata: { org_id: "org_a" },
      })),
    },
  };
}

function event(type: string, object: Record<string, unknown>) {
  return { id: "evt_1", type, data: { object } } as never;
}

function paidCheckout(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_1",
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    customer: "cus_1",
    metadata: { org_id: "org_a", payer_user_id: "user_b" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearQueues();
  clientMock.getUserById.mockResolvedValue({ email: CLIENT, firstName: null, lastName: null });
});

describe("the Stripe customer's email follows the last person who pays", () => {
  it("a top-up paid by user B makes B's email the customer's, in Stripe and in the mirror", async () => {
    const stripe = makeStripe();
    await adoptPayerForEvent(event("checkout.session.completed", paidCheckout()), stripe as never);

    expect(clientMock.getUserById).toHaveBeenCalledWith("user_b");
    expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", { email: CLIENT });
    expect(recordApiSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cus_1", email: CLIENT }),
      "customer",
      "org_a"
    );
  });

  it("a payer with no name on record clears the previous person's name (never keeps someone else's)", async () => {
    const stripe = makeStripe(CREATOR, "Kevin Lourd");
    await adoptPayerForEvent(event("checkout.session.completed", paidCheckout()), stripe as never);
    expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", { email: CLIENT, name: "" });
  });

  it("the payer's name replaces the creator's name too", async () => {
    clientMock.getUserById.mockResolvedValueOnce({ email: CLIENT, firstName: "Ethan", lastName: "Halfhide" });
    const stripe = makeStripe(CLIENT, "Kevin Lourd");
    await adoptPayerForEvent(event("checkout.session.completed", paidCheckout()), stripe as never);
    expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", { name: "Ethan Halfhide" });
  });

  it("never on an unpaid (still in flight) checkout", async () => {
    const stripe = makeStripe();
    await adoptPayerForEvent(
      event("checkout.session.completed", paidCheckout({ payment_status: "unpaid" })),
      stripe as never
    );
    expect(clientMock.getUserById).not.toHaveBeenCalled();
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it("an async payment that succeeds later is adopted then", async () => {
    const stripe = makeStripe();
    await adoptPayerForEvent(
      event("checkout.session.async_payment_succeeded", paidCheckout()),
      stripe as never
    );
    expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", { email: CLIENT });
  });

  it("a checkout nobody named (no payer on it) changes nothing", async () => {
    const stripe = makeStripe();
    await adoptPayerForEvent(
      event("checkout.session.completed", paidCheckout({ metadata: { org_id: "org_a" } })),
      stripe as never
    );
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it("is a no-op when the payer's email is already the customer's", async () => {
    const stripe = makeStripe("CLIENT@acme.com");
    await adoptPayerForEvent(event("checkout.session.completed", paidCheckout()), stripe as never);
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it("keeps the email when the payer has none on record", async () => {
    clientMock.getUserById.mockResolvedValueOnce(null);
    const stripe = makeStripe();
    await adoptPayerForEvent(event("checkout.session.completed", paidCheckout()), stripe as never);
    // only the saved-method alignment reads the customer (its rule keys on the
    // customer's own email, not on the payer's record)
    expect(stripe.customers.retrieve).toHaveBeenCalledTimes(1);
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it("fails loud when client-service cannot be asked", async () => {
    clientMock.getUserById.mockRejectedValueOnce(new Error("client-service 503"));
    const stripe = makeStripe();
    await expect(
      adoptPayerForEvent(event("checkout.session.completed", paidCheckout()), stripe as never)
    ).rejects.toThrow("client-service 503");
  });

  it("only success events are candidates", () => {
    expect(isPayerIdentityEvent("checkout.session.completed")).toBe(true);
    expect(isPayerIdentityEvent("checkout.session.async_payment_succeeded")).toBe(true);
    expect(isPayerIdentityEvent("setup_intent.succeeded")).toBe(true);
    expect(isPayerIdentityEvent("checkout.session.expired")).toBe(true);
    expect(isPayerIdentityEvent("checkout.session.async_payment_failed")).toBe(false);
    expect(isPayerIdentityEvent("payment_intent.payment_failed")).toBe(false);
    expect(isPayerIdentityEvent("payment_intent.succeeded")).toBe(false);
    expect(isPayerIdentityEvent("setup_intent.setup_failed")).toBe(false);
  });
});

describe("the Stripe customer's email follows the last person who saves a card", () => {
  it("a card saved through our in-page setup adopts the payer named on the SetupIntent", async () => {
    const stripe = makeStripe();
    await adoptPayerForEvent(
      event("setup_intent.succeeded", {
        id: "seti_1",
        customer: "cus_1",
        metadata: { purpose: "card-setup", payer_user_id: "user_b" },
      }),
      stripe as never
    );
    expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", { email: CLIENT });
    // Never touches the portal opener: that belongs to another session.
    expect(dbMock.db.delete).not.toHaveBeenCalled();
  });

  it("our setup SetupIntent opened by nobody changes nothing", async () => {
    const stripe = makeStripe();
    await adoptPayerForEvent(
      event("setup_intent.succeeded", { id: "seti_1", customer: "cus_1", metadata: { purpose: "card-setup" } }),
      stripe as never
    );
    expect(dbMock.db.delete).not.toHaveBeenCalled();
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it("a card saved in the portal adopts (and consumes) the person who opened it", async () => {
    dbMock.queueDelete("card_update_openers", [{ userId: "user_b", openedAt: new Date() }]);
    const stripe = makeStripe();
    await adoptPayerForEvent(
      event("setup_intent.succeeded", { id: "seti_p", customer: "cus_1", metadata: {} }),
      stripe as never
    );
    expect(dbMock.db.delete).toHaveBeenCalled();
    expect(clientMock.getUserById).toHaveBeenCalledWith("user_b");
    expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", { email: CLIENT });
  });

  it("a SetupIntent nobody opened a portal for changes nothing", async () => {
    dbMock.queueDelete("card_update_openers", []);
    const stripe = makeStripe();
    await adoptPayerForEvent(
      event("setup_intent.succeeded", { id: "seti_p", customer: "cus_1", metadata: {} }),
      stripe as never
    );
    expect(clientMock.getUserById).not.toHaveBeenCalled();
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it("a stale portal opener is not evidence", async () => {
    dbMock.queueDelete("card_update_openers", [
      { userId: "user_b", openedAt: new Date(Date.now() - CARD_UPDATE_OPENER_MAX_AGE_MS - 60_000) },
    ]);
    const stripe = makeStripe();
    await adoptPayerForEvent(
      event("setup_intent.succeeded", { id: "seti_p", customer: "cus_1", metadata: {} }),
      stripe as never
    );
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });
});

describe("whoever opens a checkout sees their OWN identity (ETHAN-STAFF-CHECKOUT-1118)", () => {
  it("a client opening checkout on a customer staff created takes it over before the page loads: email AND name", async () => {
    clientMock.getUserById.mockResolvedValueOnce({ email: CLIENT, firstName: "Ethan", lastName: "Halfhide" });
    const stripe = makeStripe("staff@distribute.you", "Kevin Lourd");
    await showOpenerOnCustomer(stripe as never, "cus_1", "user_b");
    expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", { email: CLIENT, name: "Ethan Halfhide" });
    expect(recordApiSnapshot).toHaveBeenCalled();
  });

  it("nothing to change when the opener already is the customer", async () => {
    clientMock.getUserById.mockResolvedValueOnce({ email: CLIENT, firstName: "Ethan", lastName: "Halfhide" });
    const stripe = makeStripe(CLIENT, "Ethan Halfhide");
    await showOpenerOnCustomer(stripe as never, "cus_1", "user_b");
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it("no opener named, or no customer on the session = nothing changes", async () => {
    const stripe = makeStripe();
    await showOpenerOnCustomer(stripe as never, "cus_1", null);
    await showOpenerOnCustomer(stripe as never, null, "user_b");
    expect(clientMock.getUserById).not.toHaveBeenCalled();
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it("fails loud when client-service cannot be asked (the open is retried)", async () => {
    clientMock.getUserById.mockRejectedValueOnce(new Error("client-service 503"));
    await expect(showOpenerOnCustomer(makeStripe() as never, "cus_1", "user_b")).rejects.toThrow("client-service 503");
  });
});

describe("an abandoned checkout hands the customer back to the last payer", () => {
  const STAFF = "staff@distribute.you";
  function expired(opener = "staff_user") {
    return event("checkout.session.expired", {
      id: "cs_2",
      object: "checkout.session",
      status: "expired",
      customer: "cus_1",
      metadata: { org_id: "org_a", payer_user_id: opener },
    });
  }

  it("staff opened and abandoned on a paying client's org: the client's identity comes back", async () => {
    dbMock.queueSelect("checkout_sessions", [{ payer: "client_user" }]);
    clientMock.getUserById.mockImplementation(async (id: string) =>
      id === "staff_user"
        ? { email: STAFF, firstName: "Kevin", lastName: "Lourd" }
        : { email: CLIENT, firstName: "Ethan", lastName: "Halfhide" }
    );
    const stripe = makeStripe(STAFF, "Kevin Lourd");
    await adoptPayerForEvent(expired(), stripe as never);
    expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", { email: CLIENT, name: "Ethan Halfhide" });
  });

  it("someone opened since (the customer no longer carries the opener's email): left alone", async () => {
    dbMock.queueSelect("checkout_sessions", [{ payer: "client_user" }]);
    clientMock.getUserById.mockResolvedValue({ email: STAFF, firstName: "Kevin", lastName: "Lourd" });
    const stripe = makeStripe("someone@else.com", "Someone");
    await adoptPayerForEvent(expired(), stripe as never);
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it("nobody ever paid, or the opener IS the last payer: left alone", async () => {
    const stripe = makeStripe(STAFF);
    dbMock.queueSelect("checkout_sessions", []);
    await adoptPayerForEvent(expired(), stripe as never);
    dbMock.queueSelect("checkout_sessions", [{ payer: "staff_user" }]);
    await adoptPayerForEvent(expired(), stripe as never);
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });
});

describe("a saved method keeps no staff email once the client pays (BILLING-LINK-PAYMENT-METHOD-1118)", () => {
  it("a top-up paid by the client moves a Link method saved under staff's email to the client's", async () => {
    // The OPEN moment already gave the customer the client's email; the method
    // still carries the staff email Checkout prefilled when staff opened first.
    const stripe = makeStripe(CLIENT, null);
    stripe.paymentMethods.list.mockImplementation(async (p: { type: string }) => ({
      data:
        p.type === "link"
          ? [{ id: "pm_link", type: "link", billing_details: { email: "kevin.lourd@gmail.com", name: "Ethan Halfhide" } }]
          : [],
      has_more: false,
    }));
    await adoptPayerForEvent(event("checkout.session.completed", paidCheckout()), stripe as never);
    expect(stripe.paymentMethods.update).toHaveBeenCalledTimes(1);
    expect(stripe.paymentMethods.update).toHaveBeenCalledWith("pm_link", { billing_details: { email: CLIENT } });
    // the stored payment-method reads (they carry billing details) are dropped
    expect(dbMock.db.delete).toHaveBeenCalled();
  });

  it("an unpaid checkout touches no method", async () => {
    const stripe = makeStripe(CLIENT, null);
    await adoptPayerForEvent(
      event("checkout.session.completed", paidCheckout({ payment_status: "unpaid" })),
      stripe as never
    );
    expect(stripe.paymentMethods.list).not.toHaveBeenCalled();
  });
});
