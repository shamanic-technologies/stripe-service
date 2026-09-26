import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Stripe from "stripe";
import {
  PAYMENT_METHOD_READ_TTL_MS,
  customerTouchedByEvent,
  invalidatePaymentMethodReads,
  isStripeRateLimit,
  listPaymentMethodsForRead,
  resetPaymentMethodReads,
} from "../../src/lib/payment-method-read";

const LIST = { object: "list", data: [{ id: "pm_1", type: "card" }], has_more: false, url: "/v1/payment_methods" };

function rateLimitError() {
  return Object.assign(new Error("Request rate limit exceeded"), {
    type: "StripeRateLimitError",
    rawType: "rate_limit_error",
    statusCode: 429,
  });
}

function stripeWith(list: ReturnType<typeof vi.fn>) {
  return { paymentMethods: { list } } as unknown as Stripe;
}

beforeEach(() => resetPaymentMethodReads());
afterEach(() => vi.useRealTimers());

describe("listPaymentMethodsForRead — a burst is one Stripe call", () => {
  it("100 concurrent reads for one customer cost ONE Stripe call, all answered", async () => {
    let release!: (v: unknown) => void;
    const list = vi.fn(() => new Promise((r) => (release = r)));
    const stripe = stripeWith(list);

    const reads = Array.from({ length: 100 }, () => listPaymentMethodsForRead(stripe, "cus_a", "card"));
    release(LIST);
    const answers = await Promise.all(reads);

    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ customer: "cus_a", type: "card" });
    expect(answers.every((a) => a === answers[0])).toBe(true);
    expect(answers[0].data[0].id).toBe("pm_1");
  });

  it("sequential reads within the TTL reuse Stripe's answer; after it, ask again", async () => {
    vi.useFakeTimers();
    const list = vi.fn().mockResolvedValue(LIST);
    const stripe = stripeWith(list);

    for (let i = 0; i < 50; i++) await listPaymentMethodsForRead(stripe, "cus_a", "card");
    expect(list).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PAYMENT_METHOD_READ_TTL_MS + 1);
    await listPaymentMethodsForRead(stripe, "cus_a", "card");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keys on customer AND type — a card answer never answers a link question", async () => {
    const list = vi.fn().mockResolvedValue(LIST);
    const stripe = stripeWith(list);
    await listPaymentMethodsForRead(stripe, "cus_a", "card");
    await listPaymentMethodsForRead(stripe, "cus_a", "link");
    await listPaymentMethodsForRead(stripe, "cus_b", "card");
    await listPaymentMethodsForRead(stripe, "cus_a");
    expect(list).toHaveBeenCalledTimes(4);
    expect(list).toHaveBeenLastCalledWith({ customer: "cus_a" });
  });

  it("invalidation drops every remembered answer for that customer only", async () => {
    const list = vi.fn().mockResolvedValue(LIST);
    const stripe = stripeWith(list);
    await listPaymentMethodsForRead(stripe, "cus_a", "card");
    await listPaymentMethodsForRead(stripe, "cus_a", "link");
    await listPaymentMethodsForRead(stripe, "cus_b", "card");

    invalidatePaymentMethodReads("cus_a");
    await listPaymentMethodsForRead(stripe, "cus_a", "card");
    await listPaymentMethodsForRead(stripe, "cus_a", "link");
    await listPaymentMethodsForRead(stripe, "cus_b", "card");
    expect(list).toHaveBeenCalledTimes(5);
  });

  it("a flight started BEFORE an invalidation does not write its answer back", async () => {
    let release!: (v: unknown) => void;
    const list = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (release = r)))
      .mockResolvedValue(LIST);
    const stripe = stripeWith(list);

    const early = listPaymentMethodsForRead(stripe, "cus_a", "card");
    invalidatePaymentMethodReads("cus_a"); // a card changed mid-flight
    release(LIST);
    await early;

    await listPaymentMethodsForRead(stripe, "cus_a", "card");
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe("listPaymentMethodsForRead — Stripe rate limit", () => {
  it("backs off inside the ONE shared call and answers every waiter", async () => {
    vi.useFakeTimers();
    const list = vi.fn().mockRejectedValueOnce(rateLimitError()).mockResolvedValue(LIST);
    const stripe = stripeWith(list);

    const reads = Array.from({ length: 100 }, () => listPaymentMethodsForRead(stripe, "cus_a", "card"));
    await vi.advanceTimersByTimeAsync(1000);
    const answers = await Promise.all(reads);

    expect(list).toHaveBeenCalledTimes(2); // one attempt + one retry, not 200
    expect(answers).toHaveLength(100);
    expect(answers[0].data[0].id).toBe("pm_1");
  });

  it("still throttled after the backoff → the error propagates and nothing is remembered", async () => {
    vi.useFakeTimers();
    const list = vi.fn().mockRejectedValue(rateLimitError());
    const stripe = stripeWith(list);

    const read = listPaymentMethodsForRead(stripe, "cus_a", "card");
    const settled = read.then(
      () => "resolved",
      (e) => e
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await settled;
    expect(isStripeRateLimit(outcome)).toBe(true);
    expect(list).toHaveBeenCalledTimes(4);

    list.mockResolvedValue(LIST);
    await listPaymentMethodsForRead(stripe, "cus_a", "card");
    expect(list).toHaveBeenCalledTimes(5); // the failure was not cached
  });

  it("does not retry an error that is not a rate limit", async () => {
    const list = vi.fn().mockRejectedValue(Object.assign(new Error("boom"), { type: "StripeAPIError", statusCode: 500 }));
    const stripe = stripeWith(list);
    await expect(listPaymentMethodsForRead(stripe, "cus_a", "card")).rejects.toThrow("boom");
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe("customerTouchedByEvent", () => {
  const ev = (type: string, object: unknown, previous?: unknown) =>
    ({ type, data: { object, previous_attributes: previous } }) as unknown as Stripe.Event;

  it("reads the customer off an attach", () => {
    expect(customerTouchedByEvent(ev("payment_method.attached", { customer: "cus_a" }))).toBe("cus_a");
  });
  it("reads the PREVIOUS customer off a detach, which nulls the object's", () => {
    expect(
      customerTouchedByEvent(ev("payment_method.detached", { customer: null }, { customer: "cus_a" }))
    ).toBe("cus_a");
  });
  it("covers card-adding checkout and setup events", () => {
    expect(customerTouchedByEvent(ev("checkout.session.completed", { customer: "cus_a" }))).toBe("cus_a");
    expect(customerTouchedByEvent(ev("setup_intent.succeeded", { customer: { id: "cus_b" } }))).toBe("cus_b");
  });
  it("ignores events that do not change which methods a customer holds", () => {
    expect(customerTouchedByEvent(ev("charge.succeeded", { customer: "cus_a" }))).toBeNull();
  });
});
