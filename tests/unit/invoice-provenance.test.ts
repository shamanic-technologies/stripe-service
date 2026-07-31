import { describe, it, expect } from "vitest";
import type Stripe from "stripe";
import {
  paymentIntentIdFromInvoice,
  paymentIntentProvenance,
} from "../../src/lib/invoice-provenance";

const invoice = (extra: Record<string, unknown>): Stripe.Invoice =>
  ({ id: "in_1", object: "invoice", ...extra }) as unknown as Stripe.Invoice;

describe("paymentIntentIdFromInvoice", () => {
  it("reads the PaymentIntent out of the `payments` list (current API version)", () => {
    expect(
      paymentIntentIdFromInvoice(
        invoice({
          payments: {
            object: "list",
            data: [
              {
                id: "inpay_1",
                payment: { type: "payment_intent", payment_intent: "pi_1" },
              },
            ],
          },
        })
      )
    ).toBe("pi_1");
  });

  it("accepts an expanded PaymentIntent object, not just an id", () => {
    expect(
      paymentIntentIdFromInvoice(
        invoice({
          payments: {
            data: [{ payment: { payment_intent: { id: "pi_expanded" } } }],
          },
        })
      )
    ).toBe("pi_expanded");
  });

  it("falls back to the legacy top-level `payment_intent` field", () => {
    expect(
      paymentIntentIdFromInvoice(invoice({ payment_intent: "pi_legacy" }))
    ).toBe("pi_legacy");
  });

  it("skips payment entries that carry no PaymentIntent", () => {
    expect(
      paymentIntentIdFromInvoice(
        invoice({
          payments: {
            data: [
              { payment: { type: "payment_record" } },
              { payment: { payment_intent: "pi_2" } },
            ],
          },
        })
      )
    ).toBe("pi_2");
  });

  it("returns null when the invoice references no PaymentIntent at all", () => {
    expect(paymentIntentIdFromInvoice(invoice({}))).toBeNull();
    expect(
      paymentIntentIdFromInvoice(invoice({ payments: { data: [] } }))
    ).toBeNull();
  });
});

describe("paymentIntentProvenance", () => {
  it("carries every caller key through and adds the invoice back-reference", () => {
    expect(
      paymentIntentProvenance(
        { type: "auto_reload", org_id: "org_1", month: "2026-07" },
        "in_9"
      )
    ).toEqual({
      type: "auto_reload",
      org_id: "org_1",
      month: "2026-07",
      invoice_id: "in_9",
    });
  });

  it("invents nothing when the caller supplied no metadata", () => {
    expect(paymentIntentProvenance({}, "in_9")).toEqual({ invoice_id: "in_9" });
  });
});
