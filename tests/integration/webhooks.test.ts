import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { TEST_ORG_ID } from "../helpers/mocks";

const { dbMock, constructWebhookEventMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi), constructWebhookEventMock: vi.fn() };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));
vi.mock("../../src/lib/stripe-client", () => ({
  makeStripeClient: vi.fn(),
  getWebhookClient: vi.fn(),
  constructWebhookEvent: (...args: unknown[]) => constructWebhookEventMock(...args),
  isStripeError: (e: unknown) => e instanceof Error,
  stripeErrorStatus: () => 500,
  isResourceMissing: () => false,
}));
vi.mock("../../src/lib/key-client", () => ({
  resolvePlatformKey: vi
    .fn()
    .mockResolvedValue({ provider: "stripe-webhook", key: "whsec_test_fake" }),
  getDecryptedStripeKey: vi.fn(),
}));

import { createTestApp } from "../helpers/test-app";

const app = createTestApp();

beforeEach(() => {
  vi.clearAllMocks();
  constructWebhookEventMock.mockReset();
});

describe("POST /v1/webhooks", () => {
  it("rejects when signature header is missing", async () => {
    const res = await request(app)
      .post("/v1/webhooks")
      .set("Content-Type", "application/json")
      .send({ foo: "bar" });
    expect(res.status).toBe(400);
  });

  it("rejects when signature verification fails", async () => {
    constructWebhookEventMock.mockImplementationOnce(() => {
      throw new Error("Webhook signature verification failed");
    });

    const res = await request(app)
      .post("/v1/webhooks")
      .set("stripe-signature", "bad-sig")
      .set("Content-Type", "application/json")
      .send({ foo: "bar" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid signature");
  });

  it("processes a valid webhook and persists event row", async () => {
    constructWebhookEventMock.mockReturnValueOnce({
      id: "evt_test_1",
      type: "customer.created",
      api_version: "2024-12-18",
      livemode: false,
      created: 1700000000,
      data: {
        object: {
          id: "cus_evt_1",
          object: "customer",
          email: "evt@example.com",
          metadata: { org_id: TEST_ORG_ID },
          created: 1700000000,
          livemode: false,
        },
      },
    });
    dbMock.queueInsert("events", [{ id: "evt_test_1" }]);

    const res = await request(app)
      .post("/v1/webhooks")
      .set("stripe-signature", "t=123,v1=abc")
      .set("Content-Type", "application/json")
      .send({ id: "evt_test_1" });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(dbMock.db.insert).toHaveBeenCalled();
  });

  it("idempotent: duplicate event yields no second processing", async () => {
    constructWebhookEventMock.mockReturnValueOnce({
      id: "evt_dup",
      type: "customer.updated",
      api_version: "2024-12-18",
      livemode: false,
      created: 1700000001,
      data: {
        object: {
          id: "cus_dup",
          object: "customer",
          metadata: { org_id: TEST_ORG_ID },
          created: 1700000001,
          livemode: false,
        },
      },
    });
    // ON CONFLICT DO NOTHING returns empty when row already exists
    dbMock.queueInsert("events", []);

    const res = await request(app)
      .post("/v1/webhooks")
      .set("stripe-signature", "t=123,v1=abc")
      .set("Content-Type", "application/json")
      .send({ id: "evt_dup" });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});
