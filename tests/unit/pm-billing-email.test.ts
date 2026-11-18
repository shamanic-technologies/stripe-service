import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

import {
  alignPaymentMethodEmails,
  billingEmailFix,
  isStaffEmail,
} from "../../src/lib/pm-billing-email";

const CLIENT = "ethan.halfhide@gmail.com";
const STAFF = "kevin.lourd@gmail.com";

function pm(id: string, type: string, email: string | null) {
  return { id, type, billing_details: { email, name: "Ethan Halfhide", address: null } };
}

function makeStripe(customerEmail: string | null, methods: { card?: unknown[]; link?: unknown[] }) {
  return {
    customers: {
      retrieve: vi.fn(async () => ({ id: "cus_1", object: "customer", email: customerEmail })),
    },
    paymentMethods: {
      list: vi.fn(async (p: { type: "card" | "link" }) => ({ data: methods[p.type] ?? [], has_more: false })),
      update: vi.fn(async () => ({})),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearQueues();
});

describe("staff set (mirror of billing-service isStaffEmail)", () => {
  it("owner addresses, his test address, any @distribute.you, plus-addressing stripped", () => {
    expect(isStaffEmail("kevin.lourd@gmail.com")).toBe(true);
    expect(isStaffEmail("Kevin.Lourd+test@Gmail.com")).toBe(true);
    expect(isStaffEmail("kevin@pressbeat.io")).toBe(true);
    expect(isStaffEmail("kevin@distribute.you")).toBe(true);
    expect(isStaffEmail("anyone@distribute.you")).toBe(true);
    expect(isStaffEmail("ethan.halfhide@gmail.com")).toBe(false);
    expect(isStaffEmail(null)).toBe(false);
    expect(isStaffEmail("")).toBe(false);
  });
});

describe("the rule: a staff email on a client's method takes the client's email", () => {
  it("staff method email + client customer -> the customer's email", () => {
    expect(billingEmailFix(STAFF, CLIENT)).toBe(CLIENT);
  });
  it("client method email -> untouched", () => {
    expect(billingEmailFix("other@acme.com", CLIENT)).toBeNull();
    expect(billingEmailFix(null, CLIENT)).toBeNull();
  });
  it("staff customer (our own / test orgs) -> untouched", () => {
    expect(billingEmailFix(STAFF, "kevin@distribute.you")).toBeNull();
    expect(billingEmailFix(STAFF, null)).toBeNull();
  });
});

describe("alignPaymentMethodEmails", () => {
  it("updates only the staff-email methods of a client customer, card and Link alike, email only", async () => {
    const stripe = makeStripe(CLIENT, {
      card: [pm("pm_card_staff", "card", "kevin@distribute.you"), pm("pm_card_client", "card", CLIENT)],
      link: [pm("pm_link_staff", "link", STAFF)],
    });
    const changes = await alignPaymentMethodEmails(stripe as never, "cus_1");
    expect(changes.map((c) => c.paymentMethodId)).toEqual(["pm_card_staff", "pm_link_staff"]);
    expect(stripe.paymentMethods.update).toHaveBeenCalledTimes(2);
    expect(stripe.paymentMethods.update).toHaveBeenCalledWith("pm_link_staff", { billing_details: { email: CLIENT } });
    expect(stripe.paymentMethods.update).toHaveBeenCalledWith("pm_card_staff", { billing_details: { email: CLIENT } });
    expect(dbMock.db.delete).toHaveBeenCalled();
  });

  it("a client's own method email is left alone", async () => {
    const stripe = makeStripe(CLIENT, { card: [pm("pm_1", "card", "billing@acme.com")] });
    expect(await alignPaymentMethodEmails(stripe as never, "cus_1")).toEqual([]);
    expect(stripe.paymentMethods.update).not.toHaveBeenCalled();
    expect(dbMock.db.delete).not.toHaveBeenCalled();
  });

  it("a staff customer is left alone (never even listed)", async () => {
    const stripe = makeStripe("kevin.lourd+demo@gmail.com", { link: [pm("pm_1", "link", STAFF)] });
    expect(await alignPaymentMethodEmails(stripe as never, "cus_1")).toEqual([]);
    expect(stripe.paymentMethods.list).not.toHaveBeenCalled();
    expect(stripe.paymentMethods.update).not.toHaveBeenCalled();
  });

  it("dry-run reports without writing", async () => {
    const stripe = makeStripe(CLIENT, { link: [pm("pm_1", "link", STAFF)] });
    const changes = await alignPaymentMethodEmails(stripe as never, "cus_1", { apply: false });
    expect(changes).toEqual([{ paymentMethodId: "pm_1", customerId: "cus_1", type: "link", from: STAFF, to: CLIENT }]);
    expect(stripe.paymentMethods.update).not.toHaveBeenCalled();
    expect(dbMock.db.delete).not.toHaveBeenCalled();
  });

  it("pages through every method", async () => {
    const stripe = makeStripe(CLIENT, {});
    stripe.paymentMethods.list
      .mockResolvedValueOnce({ data: [pm("pm_a", "card", STAFF)], has_more: true } as never)
      .mockResolvedValueOnce({ data: [pm("pm_b", "card", STAFF)], has_more: false } as never)
      .mockResolvedValueOnce({ data: [], has_more: false } as never);
    const changes = await alignPaymentMethodEmails(stripe as never, "cus_1");
    expect(changes.map((c) => c.paymentMethodId)).toEqual(["pm_a", "pm_b"]);
    expect(stripe.paymentMethods.list).toHaveBeenNthCalledWith(2, expect.objectContaining({ starting_after: "pm_a" }));
  });

  it("fails loud when Stripe refuses the update", async () => {
    const stripe = makeStripe(CLIENT, { link: [pm("pm_1", "link", STAFF)] });
    stripe.paymentMethods.update.mockRejectedValueOnce(new Error("stripe 500"));
    await expect(alignPaymentMethodEmails(stripe as never, "cus_1")).rejects.toThrow("stripe 500");
  });
});
