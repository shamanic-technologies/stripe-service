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
vi.mock("../../src/lib/client-service-client", () => clientMock);

import {
  adoptPayerEmailForEvent,
  CARD_UPDATE_OPENER_MAX_AGE_MS,
  isPayerEmailEvent,
} from "../../src/lib/payer-email";
import { recordApiSnapshot } from "../../src/lib/event-processor";

const CREATOR = "creator@agency.com";
const CLIENT = "client@acme.com";

function makeStripe(currentEmail: string | null = CREATOR) {
  return {
    customers: {
      retrieve: vi.fn(async () => ({ id: "cus_1", object: "customer", email: currentEmail })),
      update: vi.fn(async (_id: string, p: { email: string }) => ({
        id: "cus_1",
        object: "customer",
        email: p.email,
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
    await adoptPayerEmailForEvent(event("checkout.session.completed", paidCheckout()), stripe as never);

    expect(clientMock.getUserById).toHaveBeenCalledWith("user_b");
    expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", { email: CLIENT });
    expect(recordApiSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cus_1", email: CLIENT }),
      "customer",
      "org_a"
    );
  });

  it("changes ONLY the email", async () => {
    const stripe = makeStripe();
    await adoptPayerEmailForEvent(event("checkout.session.completed", paidCheckout()), stripe as never);
    expect(Object.keys(stripe.customers.update.mock.calls[0][1])).toEqual(["email"]);
  });

  it("never on an unpaid (still in flight) checkout", async () => {
    const stripe = makeStripe();
    await adoptPayerEmailForEvent(
      event("checkout.session.completed", paidCheckout({ payment_status: "unpaid" })),
      stripe as never
    );
    expect(clientMock.getUserById).not.toHaveBeenCalled();
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it("an async payment that succeeds later is adopted then", async () => {
    const stripe = makeStripe();
    await adoptPayerEmailForEvent(
      event("checkout.session.async_payment_succeeded", paidCheckout()),
      stripe as never
    );
    expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", { email: CLIENT });
  });

  it("a checkout nobody named (no payer on it) changes nothing", async () => {
    const stripe = makeStripe();
    await adoptPayerEmailForEvent(
      event("checkout.session.completed", paidCheckout({ metadata: { org_id: "org_a" } })),
      stripe as never
    );
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it("is a no-op when the payer's email is already the customer's", async () => {
    const stripe = makeStripe("CLIENT@acme.com");
    await adoptPayerEmailForEvent(event("checkout.session.completed", paidCheckout()), stripe as never);
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it("keeps the email when the payer has none on record", async () => {
    clientMock.getUserById.mockResolvedValueOnce(null);
    const stripe = makeStripe();
    await adoptPayerEmailForEvent(event("checkout.session.completed", paidCheckout()), stripe as never);
    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it("fails loud when client-service cannot be asked", async () => {
    clientMock.getUserById.mockRejectedValueOnce(new Error("client-service 503"));
    const stripe = makeStripe();
    await expect(
      adoptPayerEmailForEvent(event("checkout.session.completed", paidCheckout()), stripe as never)
    ).rejects.toThrow("client-service 503");
  });

  it("only success events are candidates", () => {
    expect(isPayerEmailEvent("checkout.session.completed")).toBe(true);
    expect(isPayerEmailEvent("checkout.session.async_payment_succeeded")).toBe(true);
    expect(isPayerEmailEvent("setup_intent.succeeded")).toBe(true);
    expect(isPayerEmailEvent("checkout.session.async_payment_failed")).toBe(false);
    expect(isPayerEmailEvent("payment_intent.payment_failed")).toBe(false);
    expect(isPayerEmailEvent("payment_intent.succeeded")).toBe(false);
    expect(isPayerEmailEvent("setup_intent.setup_failed")).toBe(false);
  });
});

describe("the Stripe customer's email follows the last person who saves a card", () => {
  it("a card saved through our in-page setup adopts the payer named on the SetupIntent", async () => {
    const stripe = makeStripe();
    await adoptPayerEmailForEvent(
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
    await adoptPayerEmailForEvent(
      event("setup_intent.succeeded", { id: "seti_1", customer: "cus_1", metadata: { purpose: "card-setup" } }),
      stripe as never
    );
    expect(dbMock.db.delete).not.toHaveBeenCalled();
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it("a card saved in the portal adopts (and consumes) the person who opened it", async () => {
    dbMock.queueDelete("card_update_openers", [{ userId: "user_b", openedAt: new Date() }]);
    const stripe = makeStripe();
    await adoptPayerEmailForEvent(
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
    await adoptPayerEmailForEvent(
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
    await adoptPayerEmailForEvent(
      event("setup_intent.succeeded", { id: "seti_p", customer: "cus_1", metadata: {} }),
      stripe as never
    );
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });
});
