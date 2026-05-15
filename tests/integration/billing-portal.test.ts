import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { authHeaders } from "../helpers/mocks";

const { dbMock, stripeMock } = vi.hoisted(() => {
  const { makeDbMock, makeStripeMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi), stripeMock: makeStripeMock(vi) };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));
vi.mock("../../src/lib/stripe-client", () => ({
  makeStripeClient: () => stripeMock,
  getWebhookClient: vi.fn(),
  constructWebhookEvent: vi.fn(),
  isStripeError: (e: unknown) => e instanceof Error,
  stripeErrorStatus: () => 500,
  isResourceMissing: () => false,
}));
vi.mock("../../src/lib/resolve-stripe-key", () => ({
  resolveStripeKey: vi.fn().mockResolvedValue({ key: "sk_test_xxx", keySource: "platform" }),
}));

import { createTestApp } from "../helpers/test-app";

const app = createTestApp();

describe("POST /v1/billing_portal/sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMock.billingPortal.sessions.create.mockReset();
  });

  it("creates a billing portal session", async () => {
    stripeMock.billingPortal.sessions.create.mockResolvedValueOnce({
      id: "bps_test",
      object: "billing_portal.session",
      customer: "cus_x",
      url: "https://billing.stripe.com/x",
      return_url: "https://app.example.com",
      created: 1700000000,
      livemode: false,
    });

    const res = await request(app)
      .post("/v1/billing_portal/sessions")
      .set(authHeaders())
      .send({ customer: "cus_x", return_url: "https://app.example.com" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("bps_test");
    expect(res.body.url).toBe("https://billing.stripe.com/x");
    expect(stripeMock.billingPortal.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_x", return_url: "https://app.example.com" }),
      undefined
    );
  });

  it("requires customer in body", async () => {
    const res = await request(app)
      .post("/v1/billing_portal/sessions")
      .set(authHeaders())
      .send({ return_url: "https://app.example.com" });
    expect(res.status).toBe(400);
  });
});
