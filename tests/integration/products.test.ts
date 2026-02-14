import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app";

// Mock the stripe client
vi.mock("../../src/lib/stripe-client", () => ({
  createCheckoutSession: vi.fn(),
  createPaymentIntent: vi.fn(),
  constructWebhookEvent: vi.fn(),
  createProduct: vi.fn().mockResolvedValue({
    success: true,
    productId: "prod_test_mock123",
    name: "Test Product",
    description: "A test product",
  }),
  createPrice: vi.fn().mockResolvedValue({
    success: true,
    priceId: "price_test_mock123",
    productId: "prod_test_mock123",
    unitAmountInCents: 2999,
    currency: "usd",
  }),
  createCoupon: vi.fn().mockResolvedValue({
    success: true,
    couponId: "coupon_test_mock123",
    name: "50% Off",
    percentOff: 50,
    amountOffInCents: null,
    currency: null,
    duration: "once",
  }),
  getProduct: vi.fn().mockResolvedValue({
    success: true,
    data: {
      productId: "prod_test_mock123",
      name: "Test Product",
      description: "A test product",
    },
  }),
  getPrice: vi.fn().mockResolvedValue({
    success: true,
    data: {
      priceId: "price_test_mock123",
      productId: "prod_test_mock123",
      unitAmountInCents: 2999,
      currency: "usd",
      active: true,
    },
  }),
  listPricesByProduct: vi.fn().mockResolvedValue({
    success: true,
    data: [
      {
        priceId: "price_test_mock123",
        productId: "prod_test_mock123",
        unitAmountInCents: 2999,
        currency: "usd",
        active: true,
      },
    ],
  }),
  getCoupon: vi.fn().mockResolvedValue({
    success: true,
    data: {
      couponId: "coupon_test_mock123",
      name: "50% Off",
      percentOff: 50,
      amountOffInCents: null,
      currency: null,
      duration: "once",
      valid: true,
    },
  }),
}));

// Mock the runs client
vi.mock("../../src/lib/runs-client", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run_mock123" }),
  updateRun: vi.fn().mockResolvedValue({}),
  addCosts: vi.fn().mockResolvedValue({ costs: [] }),
}));

// Mock the database
vi.mock("../../src/db", () => {
  const mockInsert = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([]),
    }),
  });
  return {
    db: {
      insert: mockInsert,
      query: {},
    },
  };
});

const app = createTestApp();
const API_KEY = "test-secret-key";

describe("POST /products/create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a product successfully", async () => {
    const res = await request(app)
      .post("/products/create")
      .set("X-API-Key", API_KEY)
      .send({
        name: "Premium Course",
        description: "A comprehensive TypeScript course",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.productId).toBe("prod_test_mock123");
    expect(res.body.name).toBe("Test Product");
  });

  it("creates a product with metadata", async () => {
    const res = await request(app)
      .post("/products/create")
      .set("X-API-Key", API_KEY)
      .send({
        name: "Premium Course",
        metadata: { courseId: "course_abc" },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 400 for missing name", async () => {
    const res = await request(app)
      .post("/products/create")
      .set("X-API-Key", API_KEY)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("returns 400 for empty name", async () => {
    const res = await request(app)
      .post("/products/create")
      .set("X-API-Key", API_KEY)
      .send({ name: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("returns 401 without API key", async () => {
    const res = await request(app)
      .post("/products/create")
      .send({ name: "Test" });

    expect(res.status).toBe(401);
  });

  it("returns 403 with wrong API key", async () => {
    const res = await request(app)
      .post("/products/create")
      .set("X-API-Key", "wrong-key")
      .send({ name: "Test" });

    expect(res.status).toBe(403);
  });

  it("returns 500 when Stripe fails", async () => {
    const { createProduct } = await import("../../src/lib/stripe-client");
    (createProduct as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: "Stripe API error",
    });

    const res = await request(app)
      .post("/products/create")
      .set("X-API-Key", API_KEY)
      .send({ name: "Test Product" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Stripe API error");
  });
});

describe("POST /prices/create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a one-time price successfully", async () => {
    const res = await request(app)
      .post("/prices/create")
      .set("X-API-Key", API_KEY)
      .send({
        productId: "prod_123",
        unitAmountInCents: 2999,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.priceId).toBe("price_test_mock123");
    expect(res.body.productId).toBe("prod_test_mock123");
    expect(res.body.unitAmountInCents).toBe(2999);
    expect(res.body.currency).toBe("usd");
  });

  it("creates a recurring price successfully", async () => {
    const res = await request(app)
      .post("/prices/create")
      .set("X-API-Key", API_KEY)
      .send({
        productId: "prod_123",
        unitAmountInCents: 999,
        currency: "eur",
        recurring: { interval: "month" },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 400 for missing productId", async () => {
    const res = await request(app)
      .post("/prices/create")
      .set("X-API-Key", API_KEY)
      .send({
        unitAmountInCents: 2999,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("returns 400 for zero amount", async () => {
    const res = await request(app)
      .post("/prices/create")
      .set("X-API-Key", API_KEY)
      .send({
        productId: "prod_123",
        unitAmountInCents: 0,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("returns 400 for negative amount", async () => {
    const res = await request(app)
      .post("/prices/create")
      .set("X-API-Key", API_KEY)
      .send({
        productId: "prod_123",
        unitAmountInCents: -100,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("returns 401 without API key", async () => {
    const res = await request(app)
      .post("/prices/create")
      .send({
        productId: "prod_123",
        unitAmountInCents: 2999,
      });

    expect(res.status).toBe(401);
  });

  it("returns 500 when Stripe fails", async () => {
    const { createPrice } = await import("../../src/lib/stripe-client");
    (createPrice as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: "Invalid product ID",
    });

    const res = await request(app)
      .post("/prices/create")
      .set("X-API-Key", API_KEY)
      .send({
        productId: "prod_invalid",
        unitAmountInCents: 2999,
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Invalid product ID");
  });
});

describe("POST /coupons/create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a percentage coupon successfully", async () => {
    const res = await request(app)
      .post("/coupons/create")
      .set("X-API-Key", API_KEY)
      .send({
        name: "50% Off",
        percentOff: 50,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.couponId).toBe("coupon_test_mock123");
    expect(res.body.name).toBe("50% Off");
    expect(res.body.percentOff).toBe(50);
    expect(res.body.duration).toBe("once");
  });

  it("creates a fixed amount coupon successfully", async () => {
    const { createCoupon } = await import("../../src/lib/stripe-client");
    (createCoupon as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      couponId: "coupon_fixed_mock",
      name: "$10 Off",
      percentOff: null,
      amountOffInCents: 1000,
      currency: "usd",
      duration: "once",
    });

    const res = await request(app)
      .post("/coupons/create")
      .set("X-API-Key", API_KEY)
      .send({
        name: "$10 Off",
        amountOffInCents: 1000,
        currency: "usd",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.amountOffInCents).toBe(1000);
    expect(res.body.currency).toBe("usd");
  });

  it("returns 400 for missing percentOff and amountOffInCents", async () => {
    const res = await request(app)
      .post("/coupons/create")
      .set("X-API-Key", API_KEY)
      .send({
        name: "Invalid",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("returns 400 for amountOffInCents without currency", async () => {
    const res = await request(app)
      .post("/coupons/create")
      .set("X-API-Key", API_KEY)
      .send({
        amountOffInCents: 1000,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("returns 401 without API key", async () => {
    const res = await request(app)
      .post("/coupons/create")
      .send({ percentOff: 50 });

    expect(res.status).toBe(401);
  });

  it("returns 500 when Stripe fails", async () => {
    const { createCoupon } = await import("../../src/lib/stripe-client");
    (createCoupon as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: "Stripe API error",
    });

    const res = await request(app)
      .post("/coupons/create")
      .set("X-API-Key", API_KEY)
      .send({ percentOff: 50 });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Stripe API error");
  });
});

describe("GET /products/:productId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a product successfully", async () => {
    const res = await request(app)
      .get("/products/prod_test_mock123")
      .set("X-API-Key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.productId).toBe("prod_test_mock123");
    expect(res.body.name).toBe("Test Product");
    expect(res.body.description).toBe("A test product");
  });

  it("returns 404 when product not found", async () => {
    const { getProduct } = await import("../../src/lib/stripe-client");
    (getProduct as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: "Product not found",
    });

    const res = await request(app)
      .get("/products/prod_nonexistent")
      .set("X-API-Key", API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Product not found");
  });

  it("returns 401 without API key", async () => {
    const res = await request(app).get("/products/prod_test_mock123");

    expect(res.status).toBe(401);
  });
});

describe("GET /prices/:priceId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a price successfully", async () => {
    const res = await request(app)
      .get("/prices/price_test_mock123")
      .set("X-API-Key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.priceId).toBe("price_test_mock123");
    expect(res.body.productId).toBe("prod_test_mock123");
    expect(res.body.unitAmountInCents).toBe(2999);
    expect(res.body.currency).toBe("usd");
    expect(res.body.active).toBe(true);
  });

  it("returns 404 when price not found", async () => {
    const { getPrice } = await import("../../src/lib/stripe-client");
    (getPrice as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: "Price not found",
    });

    const res = await request(app)
      .get("/prices/price_nonexistent")
      .set("X-API-Key", API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Price not found");
  });

  it("returns 401 without API key", async () => {
    const res = await request(app).get("/prices/price_test_mock123");

    expect(res.status).toBe(401);
  });
});

describe("GET /prices/by-product/:productId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns prices for a product", async () => {
    const res = await request(app)
      .get("/prices/by-product/prod_test_mock123")
      .set("X-API-Key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.prices).toHaveLength(1);
    expect(res.body.prices[0].priceId).toBe("price_test_mock123");
    expect(res.body.prices[0].unitAmountInCents).toBe(2999);
  });

  it("returns 500 when Stripe fails", async () => {
    const { listPricesByProduct } = await import("../../src/lib/stripe-client");
    (listPricesByProduct as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: "Stripe error",
    });

    const res = await request(app)
      .get("/prices/by-product/prod_test_mock123")
      .set("X-API-Key", API_KEY);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Stripe error");
  });

  it("returns 401 without API key", async () => {
    const res = await request(app).get("/prices/by-product/prod_test_mock123");

    expect(res.status).toBe(401);
  });
});

describe("GET /coupons/:couponId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a coupon successfully", async () => {
    const res = await request(app)
      .get("/coupons/coupon_test_mock123")
      .set("X-API-Key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.couponId).toBe("coupon_test_mock123");
    expect(res.body.name).toBe("50% Off");
    expect(res.body.percentOff).toBe(50);
    expect(res.body.duration).toBe("once");
    expect(res.body.valid).toBe(true);
  });

  it("returns 404 when coupon not found", async () => {
    const { getCoupon } = await import("../../src/lib/stripe-client");
    (getCoupon as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: "Coupon not found",
    });

    const res = await request(app)
      .get("/coupons/coupon_nonexistent")
      .set("X-API-Key", API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Coupon not found");
  });

  it("returns 401 without API key", async () => {
    const res = await request(app).get("/coupons/coupon_test_mock123");

    expect(res.status).toBe(401);
  });
});

describe("Idempotent creates with custom id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a product with custom id", async () => {
    const res = await request(app)
      .post("/products/create")
      .set("X-API-Key", API_KEY)
      .send({
        id: "prod_custom_123",
        name: "Custom Product",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { createProduct } = await import("../../src/lib/stripe-client");
    expect(createProduct).toHaveBeenCalledWith(
      expect.objectContaining({ id: "prod_custom_123" })
    );
  });

  it("creates a coupon with custom id", async () => {
    const res = await request(app)
      .post("/coupons/create")
      .set("X-API-Key", API_KEY)
      .send({
        id: "coupon_custom_123",
        percentOff: 25,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { createCoupon } = await import("../../src/lib/stripe-client");
    expect(createCoupon).toHaveBeenCalledWith(
      expect.objectContaining({ id: "coupon_custom_123" })
    );
  });
});
