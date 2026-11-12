import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Stripe from "stripe";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});
vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

import {
  PAYMENT_METHOD_READ_TTL_MS,
  STORED_MAX_AGE_MS,
  refreshPaymentMethodReads,
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

beforeEach(() => {
  resetPaymentMethodReads();
  dbMock.clearQueues();
  dbMock.clearCaptured();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe("listPaymentMethodsForRead — a burst is one Stripe call", () => {
  it("100 concurrent reads for one customer cost ONE Stripe call, all answered", async () => {
    let release!: (v: unknown) => void;
    const list = vi.fn(() => new Promise((r) => (release = r)));
    const stripe = stripeWith(list);

    const reads = Array.from({ length: 100 }, () => listPaymentMethodsForRead(stripe, "cus_a", "card"));
    await new Promise((r) => setImmediate(r)); // the stored-row read misses, Stripe is in flight
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
    await new Promise((r) => setImmediate(r)); // the stored-row read misses, Stripe is in flight
    await invalidatePaymentMethodReads("cus_a"); // a card changed mid-flight
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

describe("listPaymentMethodsForRead — the STORED answer (MON-PAGE-SPEED-2-1112)", () => {
  it("a stored answer younger than the ceiling is served with no Stripe call", async () => {
    dbMock.queueSelect("payment_method_reads", [{ body: LIST, readAt: new Date(Date.now() - 60_000) }]);
    const list = vi.fn().mockResolvedValue({ ...LIST, data: [] });
    const answer = await listPaymentMethodsForRead(stripeWith(list), "cus_a", "card");
    expect(list).not.toHaveBeenCalled();
    expect(answer.data[0].id).toBe("pm_1");
  });

  it("a stored answer older than the ceiling is never served: Stripe is asked and its answer stored", async () => {
    dbMock.queueSelect("payment_method_reads", [
      { body: { ...LIST, data: [] }, readAt: new Date(Date.now() - STORED_MAX_AGE_MS - 1) },
    ]);
    const list = vi.fn().mockResolvedValue(LIST);
    const answer = await listPaymentMethodsForRead(stripeWith(list), "cus_a", "card");
    expect(list).toHaveBeenCalledTimes(1);
    expect(answer.data[0].id).toBe("pm_1");
    expect(dbMock.lastInsertValues("payment_method_reads")).toMatchObject({
      customerId: "cus_a",
      type: "card",
      body: LIST,
    });
  });

  it("an untyped list is stored under type ''", async () => {
    const list = vi.fn().mockResolvedValue(LIST);
    await listPaymentMethodsForRead(stripeWith(list), "cus_a");
    expect(dbMock.lastInsertValues("payment_method_reads")).toMatchObject({ customerId: "cus_a", type: "" });
  });

  it("an answer superseded by a card-changing event mid-flight is never stored", async () => {
    let release!: (v: unknown) => void;
    const list = vi.fn().mockImplementationOnce(() => new Promise((r) => (release = r)));
    const early = listPaymentMethodsForRead(stripeWith(list), "cus_a", "card");
    await new Promise((r) => setImmediate(r)); // the stored-row read ran, Stripe is in flight
    await invalidatePaymentMethodReads("cus_a");
    release(LIST);
    await early;
    expect(dbMock.lastInsertValues("payment_method_reads")).toBeUndefined();
  });

  it("invalidation deletes the stored rows, and a delete failure is loud", async () => {
    await invalidatePaymentMethodReads("cus_a");
    expect(dbMock.db.delete).toHaveBeenCalledTimes(1);

    dbMock.db.delete.mockImplementationOnce(() => {
      throw new Error("db down");
    });
    await expect(invalidatePaymentMethodReads("cus_a")).rejects.toThrow("db down");
  });

  it("refresh after an event stores the card AND link answers", async () => {
    const list = vi.fn().mockResolvedValue(LIST);
    await refreshPaymentMethodReads(stripeWith(list), "cus_a");
    expect(list).toHaveBeenCalledWith({ customer: "cus_a", type: "card" });
    expect(list).toHaveBeenCalledWith({ customer: "cus_a", type: "link" });
    expect(dbMock.db.insert).toHaveBeenCalledTimes(2);
  });
});
