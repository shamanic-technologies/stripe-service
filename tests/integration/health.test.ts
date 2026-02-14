import { describe, it, expect, vi } from "vitest";
import request from "supertest";

// Mock the database module (imported transitively by routes)
vi.mock("../../src/db", () => ({
  db: { query: {}, insert: vi.fn(), update: vi.fn(), select: vi.fn(), delete: vi.fn() },
}));

import { createTestApp } from "../helpers/test-app";

const app = createTestApp();

describe("Health endpoints", () => {
  it("GET / returns service name", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toBe("Stripe Service API");
  });

  it("GET /health returns ok status", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      service: "stripe-service",
    });
  });
});
