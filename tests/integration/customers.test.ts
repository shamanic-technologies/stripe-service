import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { authHeaders, TEST_ORG_ID } from "../helpers/mocks";

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
  isResourceMissing: (e: unknown) =>
    typeof e === "object" && e !== null && "statusCode" in (e as Record<string, unknown>) &&
    (e as { statusCode?: number }).statusCode === 404,
}));
vi.mock("../../src/lib/resolve-stripe-key", () => ({
  resolveStripeKey: vi.fn().mockResolvedValue({ key: "sk_test_xxx", keySource: "platform" }),
}));

import { createTestApp } from "../helpers/test-app";

const app = createTestApp();

describe("POST /v1/customers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMock.customers.create.mockReset();
  });

  it("creates a customer and forwards Stripe-shape body", async () => {
    stripeMock.customers.create.mockResolvedValueOnce({
      id: "cus_test_123",
      object: "customer",
      email: "test@example.com",
      metadata: { org_id: TEST_ORG_ID },
      created: 1700000000,
      livemode: false,
    });

    const res = await request(app)
      .post("/v1/customers")
      .set(authHeaders())
      .send({ email: "test@example.com", name: "Jane" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("cus_test_123");
    expect(res.body.email).toBe("test@example.com");
    expect(stripeMock.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "test@example.com",
        name: "Jane",
        metadata: expect.objectContaining({ org_id: TEST_ORG_ID }),
      }),
      undefined
    );
  });

  it("forwards Idempotency-Key to Stripe SDK", async () => {
    stripeMock.customers.create.mockResolvedValueOnce({
      id: "cus_idem_1",
      object: "customer",
      metadata: { org_id: TEST_ORG_ID },
      created: 1700000000,
      livemode: false,
    });

    await request(app)
      .post("/v1/customers")
      .set(authHeaders())
      .set("Idempotency-Key", "idem-abc-123")
      .send({ email: "idem@example.com" });

    expect(stripeMock.customers.create).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ idempotencyKey: "idem-abc-123" })
    );
  });

  it("returns 400 on invalid body", async () => {
    const res = await request(app)
      .post("/v1/customers")
      .set(authHeaders())
      .send({ email: "not-an-email" });

    expect(res.status).toBe(400);
  });
});

describe("GET /v1/customers/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMock.customers.retrieve.mockReset();
  });

  it("returns DB row when present (no Stripe call)", async () => {
    dbMock.queueSelect("customers", [
      {
        id: "cus_cache_hit",
        orgId: TEST_ORG_ID,
        rawJson: { id: "cus_cache_hit", object: "customer", email: "cached@example.com" },
      },
    ]);

    const res = await request(app).get("/v1/customers/cus_cache_hit").set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("cus_cache_hit");
    expect(res.body.email).toBe("cached@example.com");
    expect(stripeMock.customers.retrieve).not.toHaveBeenCalled();
  });

  it("falls back to Stripe and upserts when DB miss", async () => {
    dbMock.queueSelect("customers", []);
    stripeMock.customers.retrieve.mockResolvedValueOnce({
      id: "cus_remote",
      object: "customer",
      email: "remote@example.com",
      metadata: { org_id: TEST_ORG_ID },
      created: 1700000000,
      livemode: false,
      deleted: false,
    });

    const res = await request(app).get("/v1/customers/cus_remote").set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("cus_remote");
    expect(stripeMock.customers.retrieve).toHaveBeenCalledWith("cus_remote");
  });

  it("returns 404 when Stripe returns 404", async () => {
    dbMock.queueSelect("customers", []);
    const err = new Error("missing") as Error & { statusCode?: number };
    err.statusCode = 404;
    stripeMock.customers.retrieve.mockRejectedValueOnce(err);

    const res = await request(app).get("/v1/customers/cus_nope").set(authHeaders());
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/customers/:id (update)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMock.customers.update.mockReset();
  });

  it("updates and returns the Stripe customer", async () => {
    stripeMock.customers.update.mockResolvedValueOnce({
      id: "cus_update_1",
      object: "customer",
      email: "new@example.com",
      metadata: { org_id: TEST_ORG_ID },
      created: 1700000000,
      livemode: false,
    });

    const res = await request(app)
      .post("/v1/customers/cus_update_1")
      .set(authHeaders())
      .send({ email: "new@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.email).toBe("new@example.com");
    expect(stripeMock.customers.update).toHaveBeenCalledWith(
      "cus_update_1",
      expect.objectContaining({ email: "new@example.com" }),
      undefined
    );
  });
});

describe("GET /v1/customers (list)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns Stripe-shape list from DB", async () => {
    dbMock.queueSelect("customers", [
      { id: "cus_a", rawJson: { id: "cus_a", object: "customer" } },
      { id: "cus_b", rawJson: { id: "cus_b", object: "customer" } },
    ]);

    const res = await request(app).get("/v1/customers?limit=10").set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
    expect(res.body.url).toBe("/v1/customers");
    expect(res.body.data).toHaveLength(2);
    expect(res.body.has_more).toBe(false);
  });

  it("respects limit and sets has_more", async () => {
    // Return 3 rows for a limit of 2 -> has_more=true, data slice = first 2
    dbMock.queueSelect("customers", [
      { id: "cus_a", rawJson: { id: "cus_a", object: "customer" } },
      { id: "cus_b", rawJson: { id: "cus_b", object: "customer" } },
      { id: "cus_c", rawJson: { id: "cus_c", object: "customer" } },
    ]);

    const res = await request(app).get("/v1/customers?limit=2").set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.has_more).toBe(true);
  });

  it("accepts single metadata filter", async () => {
    dbMock.queueSelect("customers", [
      {
        id: "cus_match",
        rawJson: { id: "cus_match", object: "customer", metadata: { brand_id: "brand_A" } },
      },
    ]);

    const res = await request(app)
      .get("/v1/customers?metadata[brand_id]=brand_A")
      .set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe("cus_match");
  });

  it("accepts multiple metadata filters AND'd", async () => {
    dbMock.queueSelect("customers", [
      {
        id: "cus_both",
        rawJson: {
          id: "cus_both",
          object: "customer",
          metadata: { brand_id: "brand_A", campaign_id: "camp_X" },
        },
      },
    ]);

    const res = await request(app)
      .get("/v1/customers?metadata[brand_id]=brand_A&metadata[campaign_id]=camp_X")
      .set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("combines metadata with email + limit filters", async () => {
    dbMock.queueSelect("customers", [
      {
        id: "cus_combo",
        rawJson: {
          id: "cus_combo",
          object: "customer",
          email: "combo@example.com",
          metadata: { brand_id: "brand_A" },
        },
      },
    ]);

    const res = await request(app)
      .get("/v1/customers?metadata[brand_id]=brand_A&email=combo@example.com&limit=5")
      .set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("rejects 400 when metadata value is not a string", async () => {
    const res = await request(app)
      .get("/v1/customers?metadata[brand_id][]=brand_A&metadata[brand_id][]=brand_B")
      .set(authHeaders());

    expect(res.status).toBe(400);
  });
});
