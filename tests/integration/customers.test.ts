import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const mockCreateCustomer = vi.fn();
const mockListCustomers = vi.fn();
const mockGetCustomer = vi.fn();
const mockUpdateCustomer = vi.fn();

vi.mock("../../src/lib/stripe-client", () => ({
  createCustomer: (...args: any[]) => mockCreateCustomer(...args),
  listCustomers: (...args: any[]) => mockListCustomers(...args),
  getCustomer: (...args: any[]) => mockGetCustomer(...args),
  updateCustomer: (...args: any[]) => mockUpdateCustomer(...args),
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
  createCoupon: vi.fn(),
  listCoupons: vi.fn(),
  getCoupon: vi.fn(),
  deleteCoupon: vi.fn(),
}));

vi.mock("../../src/db", () => ({
  db: { query: {}, insert: vi.fn(), update: vi.fn(), select: vi.fn(), delete: vi.fn() },
}));

import { createTestApp } from "../helpers/test-app";

const app = createTestApp();
const API_KEY = "test-secret-key";

describe("Customers API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /customers", () => {
    it("creates a customer", async () => {
      mockCreateCustomer.mockResolvedValue({ id: "cus_123", email: "test@example.com" });

      const res = await request(app)
        .post("/customers")
        .set("X-API-Key", API_KEY)
        .send({ email: "test@example.com", name: "Test User" });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe("cus_123");
      expect(res.body.email).toBe("test@example.com");
    });

    it("creates a customer with no fields (all optional)", async () => {
      mockCreateCustomer.mockResolvedValue({ id: "cus_456" });

      const res = await request(app)
        .post("/customers")
        .set("X-API-Key", API_KEY)
        .send({});

      expect(res.status).toBe(200);
    });

    it("returns 400 for invalid email", async () => {
      const res = await request(app)
        .post("/customers")
        .set("X-API-Key", API_KEY)
        .send({ email: "not-an-email" });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /customers", () => {
    it("lists customers", async () => {
      mockListCustomers.mockResolvedValue({
        data: [{ id: "cus_1" }, { id: "cus_2" }],
        has_more: true,
      });

      const res = await request(app)
        .get("/customers")
        .set("X-API-Key", API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.customers).toHaveLength(2);
      expect(res.body.hasMore).toBe(true);
    });

    it("filters by email", async () => {
      mockListCustomers.mockResolvedValue({ data: [{ id: "cus_1" }], has_more: false });

      const res = await request(app)
        .get("/customers?email=test@example.com")
        .set("X-API-Key", API_KEY);

      expect(res.status).toBe(200);
      expect(mockListCustomers).toHaveBeenCalledWith(
        expect.objectContaining({ email: "test@example.com" })
      );
    });
  });

  describe("GET /customers/:id", () => {
    it("gets a customer", async () => {
      mockGetCustomer.mockResolvedValue({ id: "cus_123", email: "test@example.com" });

      const res = await request(app)
        .get("/customers/cus_123")
        .set("X-API-Key", API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe("cus_123");
    });

    it("returns 404 for missing customer", async () => {
      mockGetCustomer.mockRejectedValue({ statusCode: 404, code: "resource_missing" });

      const res = await request(app)
        .get("/customers/cus_missing")
        .set("X-API-Key", API_KEY);

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /customers/:id", () => {
    it("updates a customer", async () => {
      mockUpdateCustomer.mockResolvedValue({ id: "cus_123", name: "Updated Name" });

      const res = await request(app)
        .patch("/customers/cus_123")
        .set("X-API-Key", API_KEY)
        .send({ name: "Updated Name" });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Updated Name");
    });

    it("returns 404 for missing customer", async () => {
      mockUpdateCustomer.mockRejectedValue({ statusCode: 404, code: "resource_missing" });

      const res = await request(app)
        .patch("/customers/cus_missing")
        .set("X-API-Key", API_KEY)
        .send({ name: "Test" });

      expect(res.status).toBe(404);
    });
  });
});
