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
    typeof e === "object" && e !== null && (e as { statusCode?: number }).statusCode === 404,
}));
vi.mock("../../src/lib/resolve-stripe-key", () => ({
  resolveStripeKey: vi.fn().mockResolvedValue({ key: "sk_test_xxx", keySource: "platform" }),
}));

import { createTestApp } from "../helpers/test-app";

const app = createTestApp();

describe("GET /v1/payment_methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMock.paymentMethods.list.mockReset();
  });

  it("returns Stripe payment_methods list for customer in caller's org", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_x", orgId: TEST_ORG_ID }]);
    stripeMock.paymentMethods.list.mockResolvedValueOnce({
      object: "list",
      data: [{ id: "pm_card", type: "card", customer: "cus_x" }],
      has_more: false,
      url: "/v1/payment_methods",
    });

    const res = await request(app)
      .get("/v1/payment_methods?customer=cus_x")
      .set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
    expect(res.body.data[0].id).toBe("pm_card");
    expect(stripeMock.paymentMethods.list).toHaveBeenCalledWith({ customer: "cus_x" });
  });

  it("forwards type query param to Stripe SDK", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_x", orgId: TEST_ORG_ID }]);
    stripeMock.paymentMethods.list.mockResolvedValueOnce({
      object: "list",
      data: [],
      has_more: false,
      url: "/v1/payment_methods",
    });

    await request(app)
      .get("/v1/payment_methods?customer=cus_x&type=card")
      .set(authHeaders());

    expect(stripeMock.paymentMethods.list).toHaveBeenCalledWith({
      customer: "cus_x",
      type: "card",
    });
  });

  it("returns 404 when customer is not in caller's org mirror", async () => {
    dbMock.queueSelect("customers", []);

    const res = await request(app)
      .get("/v1/payment_methods?customer=cus_other")
      .set(authHeaders());

    expect(res.status).toBe(404);
    expect(stripeMock.paymentMethods.list).not.toHaveBeenCalled();
  });

  it("returns 400 when customer query param missing", async () => {
    const res = await request(app)
      .get("/v1/payment_methods")
      .set(authHeaders());
    expect(res.status).toBe(400);
    expect(stripeMock.paymentMethods.list).not.toHaveBeenCalled();
  });
});
