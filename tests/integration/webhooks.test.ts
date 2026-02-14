import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app";
import {
  makePaymentIntentSucceeded,
  makePaymentIntentFailed,
  makeChargeRefunded,
  makeDisputeCreated,
  makeCheckoutSessionCompleted,
} from "../fixtures/stripe-payloads";

// Mock the stripe client
const mockConstructWebhookEvent = vi.fn();
vi.mock("../../src/lib/stripe-client", () => ({
  createCheckoutSession: vi.fn(),
  createPaymentIntent: vi.fn(),
  constructWebhookEvent: (...args: any[]) => mockConstructWebhookEvent(...args),
}));

// Mock the database
const mockInsertValues = vi.fn().mockReturnValue({
  onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
});
const mockInsert = vi.fn().mockReturnValue({
  values: mockInsertValues,
});
const mockUpdateSet = vi.fn().mockReturnValue({
  where: vi.fn().mockResolvedValue(undefined),
});
const mockUpdate = vi.fn().mockReturnValue({
  set: mockUpdateSet,
});

vi.mock("../../src/db", () => ({
  db: {
    insert: (...args: any[]) => mockInsert(...args),
    update: (...args: any[]) => mockUpdate(...args),
    query: {},
  },
}));

const app = createTestApp();

describe("POST /webhooks/stripe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_fake";
  });

  it("handles payment_intent.succeeded", async () => {
    const paymentIntent = makePaymentIntentSucceeded();
    mockConstructWebhookEvent.mockReturnValue({
      type: "payment_intent.succeeded",
      data: { object: paymentIntent },
    });

    const res = await request(app)
      .post("/webhooks/stripe")
      .set("stripe-signature", "test_signature")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "payment_intent.succeeded" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockInsert).toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("handles payment_intent.payment_failed", async () => {
    const paymentIntent = makePaymentIntentFailed();
    mockConstructWebhookEvent.mockReturnValue({
      type: "payment_intent.payment_failed",
      data: { object: paymentIntent },
    });

    const res = await request(app)
      .post("/webhooks/stripe")
      .set("stripe-signature", "test_signature")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "payment_intent.payment_failed" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it("handles charge.refunded", async () => {
    const charge = makeChargeRefunded();
    mockConstructWebhookEvent.mockReturnValue({
      type: "charge.refunded",
      data: { object: charge },
    });

    const res = await request(app)
      .post("/webhooks/stripe")
      .set("stripe-signature", "test_signature")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "charge.refunded" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it("handles charge.dispute.created", async () => {
    const dispute = makeDisputeCreated();
    mockConstructWebhookEvent.mockReturnValue({
      type: "charge.dispute.created",
      data: { object: dispute },
    });

    const res = await request(app)
      .post("/webhooks/stripe")
      .set("stripe-signature", "test_signature")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "charge.dispute.created" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it("handles checkout.session.completed", async () => {
    const session = makeCheckoutSessionCompleted();
    mockConstructWebhookEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: { object: session },
    });

    const res = await request(app)
      .post("/webhooks/stripe")
      .set("stripe-signature", "test_signature")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "checkout.session.completed" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it("returns 400 for missing signature", async () => {
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "test" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing stripe-signature header");
  });

  it("returns 400 for invalid signature", async () => {
    mockConstructWebhookEvent.mockImplementation(() => {
      throw new Error("Invalid signature");
    });

    const res = await request(app)
      .post("/webhooks/stripe")
      .set("stripe-signature", "invalid_sig")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "test" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid signature");
  });

  it("handles unrecognized event types gracefully", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      type: "some.unknown.event",
      data: { object: {} },
    });

    const res = await request(app)
      .post("/webhooks/stripe")
      .set("stripe-signature", "test_signature")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "some.unknown.event" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });
});
