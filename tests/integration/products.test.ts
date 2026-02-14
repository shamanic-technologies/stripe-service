import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Mock the stripe client
const mockCreateProduct = vi.fn();
const mockListProducts = vi.fn();
const mockGetProduct = vi.fn();
const mockUpdateProduct = vi.fn();

vi.mock("../../src/lib/stripe-client", () => ({
  createProduct: (...args: any[]) => mockCreateProduct(...args),
  listProducts: (...args: any[]) => mockListProducts(...args),
  getProduct: (...args: any[]) => mockGetProduct(...args),
  updateProduct: (...args: any[]) => mockUpdateProduct(...args),
  createCheckoutSession: vi.fn(),
  createPaymentIntent: vi.fn(),
  constructWebhookEvent: vi.fn(),
  createPrice: vi.fn(),
  listPrices: vi.fn(),
  getPrice: vi.fn(),
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

describe("Products API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /products", () => {
    it("creates a product", async () => {
      mockCreateProduct.mockResolvedValue({ id: "prod_123", name: "Test Product", active: true });

      const res = await request(app)
        .post("/products")
        .set("X-API-Key", API_KEY)
        .send({ name: "Test Product" });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe("prod_123");
      expect(res.body.name).toBe("Test Product");
    });

    it("returns 400 for missing name", async () => {
      const res = await request(app)
        .post("/products")
        .set("X-API-Key", API_KEY)
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns 401 without API key", async () => {
      const res = await request(app).post("/products").send({ name: "Test" });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /products", () => {
    it("lists products", async () => {
      mockListProducts.mockResolvedValue({
        data: [{ id: "prod_1" }, { id: "prod_2" }],
        has_more: false,
      });

      const res = await request(app)
        .get("/products")
        .set("X-API-Key", API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.products).toHaveLength(2);
      expect(res.body.hasMore).toBe(false);
    });
  });

  describe("GET /products/:id", () => {
    it("gets a product", async () => {
      mockGetProduct.mockResolvedValue({ id: "prod_123", name: "Test" });

      const res = await request(app)
        .get("/products/prod_123")
        .set("X-API-Key", API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe("prod_123");
    });

    it("returns 404 for missing product", async () => {
      mockGetProduct.mockRejectedValue({ statusCode: 404, code: "resource_missing" });

      const res = await request(app)
        .get("/products/prod_missing")
        .set("X-API-Key", API_KEY);

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /products/:id", () => {
    it("updates a product", async () => {
      mockUpdateProduct.mockResolvedValue({ id: "prod_123", name: "Updated", active: false });

      const res = await request(app)
        .patch("/products/prod_123")
        .set("X-API-Key", API_KEY)
        .send({ name: "Updated", active: false });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Updated");
    });
  });
});
