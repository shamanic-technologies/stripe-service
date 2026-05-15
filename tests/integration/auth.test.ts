import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { TEST_API_KEY, TEST_ORG_ID, TEST_USER_ID } from "../helpers/mocks";

const { dbMock, stripeMock } = vi.hoisted(() => {
  const { makeDbMock, makeStripeMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi), stripeMock: makeStripeMock(vi) };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));
vi.mock("../../src/lib/stripe-client", () => ({
  makeStripeClient: () => stripeMock,
  getWebhookClient: vi.fn(),
  constructWebhookEvent: vi.fn(),
  isStripeError: () => false,
  stripeErrorStatus: () => 500,
  isResourceMissing: () => false,
}));
vi.mock("../../src/lib/resolve-stripe-key", () => ({
  resolveStripeKey: vi.fn().mockResolvedValue({ key: "sk_test_xxx", keySource: "platform" }),
}));

import { createTestApp } from "../helpers/test-app";

const app = createTestApp();

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SERVICE_API_KEY = TEST_API_KEY;
});

describe("Auth — X-API-Key", () => {
  it("rejects 401 when X-API-Key missing", async () => {
    const res = await request(app)
      .post("/v1/customers")
      .set("x-org-id", TEST_ORG_ID)
      .set("x-user-id", TEST_USER_ID)
      .send({ email: "x@example.com" });
    expect(res.status).toBe(401);
  });

  it("rejects 403 when X-API-Key invalid", async () => {
    const res = await request(app)
      .post("/v1/customers")
      .set("X-API-Key", "wrong-key")
      .set("x-org-id", TEST_ORG_ID)
      .set("x-user-id", TEST_USER_ID)
      .send({ email: "x@example.com" });
    expect(res.status).toBe(403);
  });

  it("allows /health without auth", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "stripe-service" });
  });

  it("allows /v1/webhooks without X-API-Key (uses signature instead)", async () => {
    const res = await request(app)
      .post("/v1/webhooks")
      .set("Content-Type", "application/json")
      .send({ foo: "bar" });
    // 400 missing signature, NOT 401
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing stripe-signature header");
  });
});

describe("Auth — identity headers", () => {
  it("rejects 400 when x-org-id missing", async () => {
    const res = await request(app)
      .post("/v1/customers")
      .set("X-API-Key", TEST_API_KEY)
      .set("x-user-id", TEST_USER_ID)
      .send({ email: "x@example.com" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });

  it("rejects 400 when x-user-id missing", async () => {
    const res = await request(app)
      .post("/v1/customers")
      .set("X-API-Key", TEST_API_KEY)
      .set("x-org-id", TEST_ORG_ID)
      .send({ email: "x@example.com" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-user-id");
  });

  it("accepts optional x-brand-id / x-campaign-id / x-workflow-slug", async () => {
    stripeMock.customers.create.mockResolvedValueOnce({
      id: "cus_opt",
      object: "customer",
      metadata: { org_id: TEST_ORG_ID },
      created: 1700000000,
      livemode: false,
    });

    const res = await request(app)
      .post("/v1/customers")
      .set("X-API-Key", TEST_API_KEY)
      .set("x-org-id", TEST_ORG_ID)
      .set("x-user-id", TEST_USER_ID)
      .set("x-brand-id", "brand_123")
      .set("x-campaign-id", "campaign_456")
      .set("x-workflow-slug", "weekly-reload")
      .send({ email: "opt@example.com" });

    expect(res.status).toBe(200);
  });
});
