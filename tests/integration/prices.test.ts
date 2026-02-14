import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const mockCreatePrice = vi.fn();
const mockListPrices = vi.fn();
const mockGetPrice = vi.fn();

vi.mock("../../src/lib/stripe-client", () => ({
  createPrice: (...args: any[]) => mockCreatePrice(...args),
  listPrices: (...args: any[]) => mockListPrices(...args),
  getPrice: (...args: any[]) => mockGetPrice(...args),
  createCheckoutSession: vi.fn(),
  createPaymentIntent: vi.fn(),
  constructWebhookEvent: vi.fn(),
  createProduct: vi.fn(),
  listProducts: vi.fn(),
  getProduct: vi.fn(),
  updateProduct: vi.fn(),
  createCoupon: vi.fn(),
  listCoupons: vi.fn(),
  getCoupon: vi.fn(),
  deleteCoupon: vi.fn(),
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

describe("Prices API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /prices", () => {
    it("creates a one-time price", async () => {
      mockCreatePrice.mockResolvedValue({ id: "price_123", unit_amount: 1999, currency: "usd" });

      const res = await request(app)
        .post("/prices")
        .set("X-API-Key", API_KEY)
        .send({ product: "prod_123", unitAmountInCents: 1999 });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe("price_123");
    });

    it("creates a recurring price", async () => {
      mockCreatePrice.mockResolvedValue({ id: "price_456", recurring: { interval: "month" } });

      const res = await request(app)
        .post("/prices")
        .set("X-API-Key", API_KEY)
        .send({
          product: "prod_123",
          unitAmountInCents: 999,
          recurring: { interval: "month" },
        });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe("price_456");
    });

    it("returns 400 for missing product", async () => {
      const res = await request(app)
        .post("/prices")
        .set("X-API-Key", API_KEY)
        .send({ unitAmountInCents: 1000 });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /prices", () => {
    it("lists prices", async () => {
      mockListPrices.mockResolvedValue({ data: [{ id: "price_1" }], has_more: false });

      const res = await request(app)
        .get("/prices")
        .set("X-API-Key", API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.prices).toHaveLength(1);
    });
  });

  describe("GET /prices/:id", () => {
    it("gets a price", async () => {
      mockGetPrice.mockResolvedValue({ id: "price_123" });

      const res = await request(app)
        .get("/prices/price_123")
        .set("X-API-Key", API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe("price_123");
    });
  });
});
