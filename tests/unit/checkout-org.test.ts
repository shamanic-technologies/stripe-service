import { describe, it, expect, vi, beforeEach } from "vitest";

const createOrder = vi.fn();
vi.mock("../../src/lib/revolut-client", () => ({
  createOrder: (...a: unknown[]) => createOrder(...a),
}));

const mirrorOrderById = vi.fn();
vi.mock("../../src/lib/revolut-processor", () => ({
  mirrorOrderById: (...a: unknown[]) => mirrorOrderById(...a),
}));

const couponsRetrieve = vi.fn();
vi.mock("../../src/lib/event-processor", () => ({
  getPlatformStripe: async () => ({ coupons: { retrieve: couponsRetrieve } }),
}));

import { checkoutViaRevolut, UnsupportedCheckout } from "../../src/lib/checkout-org";
import { VERIFICATION_AMOUNT } from "../../src/lib/card-setup";

const BASE = { orgId: "org-1", customerId: "cus-rev-1" };

const TOPUP = {
  mode: "payment" as const,
  line_items: [
    {
      price_data: {
        currency: "usd",
        product_data: { name: "Distribute credit top-up" },
        unit_amount: 5000,
      },
      quantity: 1,
    },
  ],
  success_url: "https://dashboard.example/billing?done=1",
  cancel_url: "https://dashboard.example/billing",
  customer: "cus_stripe_1",
  metadata: { org_id: "org-1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  createOrder.mockResolvedValue({
    id: "ord-1",
    state: "pending",
    checkout_url: "https://checkout.revolut.com/payment-link/tok-1",
  });
  mirrorOrderById.mockResolvedValue(undefined);
});

describe("checkoutViaRevolut — payment", () => {
  it("charges what the line items say and sends the buyer to the hosted page", async () => {
    const checkout = await checkoutViaRevolut({ ...BASE, body: TOPUP as never });

    expect(checkout).toEqual({
      object: "checkout",
      acquirer: "revolut",
      id: "ord-1",
      url: "https://checkout.revolut.com/payment-link/tok-1",
      mode: "payment",
      amount: 5000,
      currency: "USD",
      status: "pending",
    });
    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 5000,
        currency: "USD",
        capture_mode: "automatic",
        customerId: "cus-rev-1",
        save_payment_method_for: "merchant",
        redirect_url: "https://dashboard.example/billing?done=1",
        description: "Distribute credit top-up",
      })
    );
  });

  it("stamps the org so the payment lands in that org's totals", async () => {
    // This is the whole of "the money is credited": the per-org summary and the
    // payment history both read the mirror, and both already span acquirers.
    await checkoutViaRevolut({ ...BASE, body: TOPUP as never });
    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { org_id: "org-1" } })
    );
  });

  it("mirrors the order it just created, so it is readable before any webhook", async () => {
    await checkoutViaRevolut({ ...BASE, body: TOPUP as never });
    expect(mirrorOrderById).toHaveBeenCalledWith("ord-1", "api");
  });

  it("still hands back the checkout url when the mirror fails", async () => {
    // The webhook and the 5-minute poller both redo this. Losing the buyer's
    // page over it would be the expensive failure.
    mirrorOrderById.mockRejectedValue(new Error("db down"));
    const checkout = await checkoutViaRevolut({ ...BASE, body: TOPUP as never });
    expect(checkout.url).toContain("checkout.revolut.com");
  });

  it("multiplies by quantity and sums the line items", async () => {
    await checkoutViaRevolut({
      ...BASE,
      body: {
        ...TOPUP,
        line_items: [
          { ...TOPUP.line_items[0], quantity: 3 },
          {
            price_data: {
              currency: "usd",
              product_data: { name: "Extra" },
              unit_amount: 250,
            },
            quantity: 2,
          },
        ],
      } as never,
    });
    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 15500 })
    );
  });

  it("refuses a Stripe price id rather than guessing what to charge", async () => {
    await expect(
      checkoutViaRevolut({
        ...BASE,
        body: { ...TOPUP, line_items: [{ price: "price_123", quantity: 1 }] } as never,
      })
    ).rejects.toThrow(UnsupportedCheckout);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("refuses a subscription, which this acquirer has no object for", async () => {
    await expect(
      checkoutViaRevolut({ ...BASE, body: { ...TOPUP, mode: "subscription" } as never })
    ).rejects.toThrow(/subscription/i);
  });

  it("fails loud when the acquirer returns no page to send the buyer to", async () => {
    createOrder.mockResolvedValue({ id: "ord-1", state: "pending" });
    await expect(
      checkoutViaRevolut({ ...BASE, body: TOPUP as never })
    ).rejects.toThrow(/checkout_url/);
  });
});

describe("checkoutViaRevolut — the discount a buyer must be able to see", () => {
  it("takes a flat coupon off the price and names the saving on the page", async () => {
    couponsRetrieve.mockResolvedValue({
      id: "welcome_30",
      amount_off: 3000,
      currency: "usd",
    });

    const checkout = await checkoutViaRevolut({
      ...BASE,
      body: { ...TOPUP, discounts: [{ coupon: "welcome_30" }] } as never,
    });

    expect(checkout.amount).toBe(2000);
    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 2000,
        description: "Distribute credit top-up (30.00 USD off)",
      })
    );
  });

  it("applies a percentage coupon", async () => {
    couponsRetrieve.mockResolvedValue({ id: "half", percent_off: 50 });
    const checkout = await checkoutViaRevolut({
      ...BASE,
      body: { ...TOPUP, discounts: [{ coupon: "half" }] } as never,
    });
    expect(checkout.amount).toBe(2500);
  });

  it("refuses a coupon in another currency rather than taking the wrong amount off", async () => {
    couponsRetrieve.mockResolvedValue({ amount_off: 3000, currency: "eur" });
    await expect(
      checkoutViaRevolut({
        ...BASE,
        body: { ...TOPUP, discounts: [{ coupon: "eur_30" }] } as never,
      })
    ).rejects.toThrow(/eur/i);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("refuses a discount that would swallow the whole payment", async () => {
    // A zero-amount order is accepted at create on this acquirer and can then
    // never be paid, so the buyer would sit on a page that cannot complete.
    couponsRetrieve.mockResolvedValue({ amount_off: 5000, currency: "usd" });
    await expect(
      checkoutViaRevolut({
        ...BASE,
        body: { ...TOPUP, discounts: [{ coupon: "all_of_it" }] } as never,
      })
    ).rejects.toThrow(/whole payment/i);
  });
});

describe("checkoutViaRevolut — setup mode, the $0 card imprint", () => {
  const SETUP = {
    mode: "setup" as const,
    currency: "usd",
    success_url: "https://dashboard.example/billing?done=1",
    cancel_url: "https://dashboard.example/billing",
    customer: "cus_stripe_1",
    metadata: { org_id: "org-1" },
  };

  it("authorises rather than charges, and tags the hold so the poller releases it", async () => {
    const checkout = await checkoutViaRevolut({ ...BASE, body: SETUP as never });

    expect(checkout.mode).toBe("setup");
    expect(checkout.url).toContain("checkout.revolut.com");
    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: VERIFICATION_AMOUNT,
        capture_mode: "manual",
        save_payment_method_for: "merchant",
        customerId: "cus-rev-1",
        metadata: { org_id: "org-1", purpose: "card-setup" },
      })
    );
  });

  it("takes no line items and needs no amount from the caller", async () => {
    await checkoutViaRevolut({ ...BASE, body: SETUP as never });
    const [[body]] = createOrder.mock.calls;
    expect(body.amount).toBe(VERIFICATION_AMOUNT);
    expect(body.description).toMatch(/not charged/i);
  });
});
