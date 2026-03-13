import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app";

// Mock the stripe client
vi.mock("../../src/lib/stripe-client", () => ({
  createCheckoutSession: vi.fn(),
  createPaymentIntent: vi.fn(),
  constructWebhookEvent: vi.fn(),
  createProduct: vi.fn(),
  createPrice: vi.fn(),
  createCoupon: vi.fn(),
}));

// Mock the runs client
vi.mock("../../src/lib/runs-client", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run_mock123" }),
  updateRun: vi.fn().mockResolvedValue({}),
  addCosts: vi.fn().mockResolvedValue({ costs: [] }),
}));

// Mock the key resolver
vi.mock("../../src/lib/resolve-stripe-key", () => ({
  resolveStripeKey: vi.fn().mockResolvedValue({ key: "sk_test_key", keySource: "platform" }),
}));

// Mock the database
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();

vi.mock("../../src/db", () => {
  const selectChain = {
    from: (...args: any[]) => {
      mockFrom(...args);
      return { where: (...wArgs: any[]) => { mockWhere(...wArgs); return Promise.resolve([]); } };
    },
  };
  return {
    db: {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
      select: (...args: any[]) => { mockSelect(...args); return selectChain; },
      query: {},
    },
  };
});

const app = createTestApp();
const API_KEY = "test-secret-key";
const ORG_ID = "org_test_uuid";
const USER_ID = "user_test_uuid";
const RUN_ID = "run_caller_123";

const authHeaders = {
  "X-API-Key": API_KEY,
  "x-org-id": ORG_ID,
  "x-user-id": USER_ID,
  "x-run-id": RUN_ID,
};

describe("GET /stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns stats with no filters", async () => {
    const res = await request(app)
      .get("/stats")
      .set(authHeaders);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalPayments: 0,
      totalAmountInCents: 0,
      successCount: 0,
      failureCount: 0,
      refundCount: 0,
      disputeCount: 0,
    });
  });

  it("passes orgId query param as filter", async () => {
    const res = await request(app)
      .get("/stats?orgId=org_abc")
      .set(authHeaders);

    expect(res.status).toBe(200);
    expect(res.body.totalPayments).toBe(0);
  });

  it("passes brandId and campaignId query params", async () => {
    const res = await request(app)
      .get("/stats?brandId=brand_1&campaignId=camp_2")
      .set(authHeaders);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("totalPayments");
    expect(res.body).toHaveProperty("totalAmountInCents");
  });

  it("parses comma-separated runIds", async () => {
    const res = await request(app)
      .get("/stats?runIds=run_1,run_2,run_3")
      .set(authHeaders);

    expect(res.status).toBe(200);
    expect(res.body.totalPayments).toBe(0);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/stats");

    expect(res.status).toBe(401);
  });

  it("requires identity headers", async () => {
    const res = await request(app)
      .get("/stats")
      .set("X-API-Key", API_KEY);

    expect(res.status).toBe(400);
  });
});

describe("POST /stats (deprecated)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("still works with body params", async () => {
    const res = await request(app)
      .post("/stats")
      .set(authHeaders)
      .send({ orgId: "org_abc", brandId: "brand_1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalPayments: 0,
      totalAmountInCents: 0,
      successCount: 0,
      failureCount: 0,
      refundCount: 0,
      disputeCount: 0,
    });
  });

  it("still works with runIds array in body", async () => {
    const res = await request(app)
      .post("/stats")
      .set(authHeaders)
      .send({ runIds: ["run_1", "run_2"] });

    expect(res.status).toBe(200);
    expect(res.body.totalPayments).toBe(0);
  });
});
