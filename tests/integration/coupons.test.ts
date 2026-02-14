import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const mockCreateCoupon = vi.fn();
const mockListCoupons = vi.fn();
const mockGetCoupon = vi.fn();
const mockDeleteCoupon = vi.fn();

vi.mock("../../src/lib/stripe-client", () => ({
  createCoupon: (...args: any[]) => mockCreateCoupon(...args),
  listCoupons: (...args: any[]) => mockListCoupons(...args),
  getCoupon: (...args: any[]) => mockGetCoupon(...args),
  deleteCoupon: (...args: any[]) => mockDeleteCoupon(...args),
  createCheckoutSession: vi.fn(),
  createPaymentIntent: vi.fn(),
  constructWebhookEvent: vi.fn(),
  createProduct: vi.fn(),
  listProducts: vi.fn(),
  getProduct: vi.fn(),
  updateProduct: vi.fn(),
  createPrice: vi.fn(),
  listPrices: vi.fn(),
  getPrice: vi.fn(),
  createCustomer: vi.fn(),
  listCustomers: vi.fn(),
  getCustomer: vi.fn(),
  updateCustomer: vi.fn(),
}));

vi.mock("../../src/db", () => ({
  db: { query: {}, insert: vi.fn(), update: vi.fn(), select: vi.fn(), delete: vi.fn() },
}));

import { createTestApp } from "../helpers/test-app";

const app = createTestApp();
const API_KEY = "test-secret-key";

describe("Coupons API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /coupons", () => {
    it("creates a percent-off coupon", async () => {
      mockCreateCoupon.mockResolvedValue({ id: "coupon_123", percent_off: 20 });

      const res = await request(app)
        .post("/coupons")
        .set("X-API-Key", API_KEY)
        .send({ percentOff: 20, duration: "once" });

      expect(res.status).toBe(200);
      expect(res.body.percent_off).toBe(20);
    });

    it("creates an amount-off coupon", async () => {
      mockCreateCoupon.mockResolvedValue({ id: "coupon_456", amount_off: 500 });

      const res = await request(app)
        .post("/coupons")
        .set("X-API-Key", API_KEY)
        .send({ amountOffInCents: 500, currency: "usd", duration: "forever" });

      expect(res.status).toBe(200);
      expect(res.body.amount_off).toBe(500);
    });

    it("returns 400 without percentOff or amountOff", async () => {
      const res = await request(app)
        .post("/coupons")
        .set("X-API-Key", API_KEY)
        .send({ duration: "once" });

      expect(res.status).toBe(400);
    });

    it("returns 400 without duration", async () => {
      const res = await request(app)
        .post("/coupons")
        .set("X-API-Key", API_KEY)
        .send({ percentOff: 10 });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /coupons", () => {
    it("lists coupons", async () => {
      mockListCoupons.mockResolvedValue({ data: [{ id: "coupon_1" }], has_more: false });

      const res = await request(app)
        .get("/coupons")
        .set("X-API-Key", API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.coupons).toHaveLength(1);
    });
  });

  describe("GET /coupons/:id", () => {
    it("gets a coupon", async () => {
      mockGetCoupon.mockResolvedValue({ id: "coupon_123" });

      const res = await request(app)
        .get("/coupons/coupon_123")
        .set("X-API-Key", API_KEY);

      expect(res.status).toBe(200);
    });
  });

  describe("DELETE /coupons/:id", () => {
    it("deletes a coupon", async () => {
      mockDeleteCoupon.mockResolvedValue({ id: "coupon_123", deleted: true });

      const res = await request(app)
        .delete("/coupons/coupon_123")
        .set("X-API-Key", API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
    });

    it("returns 404 for missing coupon", async () => {
      mockDeleteCoupon.mockRejectedValue({ statusCode: 404, code: "resource_missing" });

      const res = await request(app)
        .delete("/coupons/coupon_missing")
        .set("X-API-Key", API_KEY);

      expect(res.status).toBe(404);
    });
  });
});
