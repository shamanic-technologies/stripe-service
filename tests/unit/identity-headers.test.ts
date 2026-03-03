import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { requireIdentityHeaders } from "../../src/middleware/identityHeaders";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(requireIdentityHeaders);

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/openapi.json", (_req, res) => res.json({ openapi: "3.0.0" }));
  app.post("/webhooks/stripe", (_req, res) => res.json({ received: true }));
  app.get("/test", (_req, res) => res.json({ orgId: res.locals.orgId, userId: res.locals.userId, runId: res.locals.runId }));
  app.post("/test", (_req, res) => res.json({ orgId: res.locals.orgId, userId: res.locals.userId, runId: res.locals.runId }));

  return app;
}

describe("requireIdentityHeaders middleware", () => {
  const app = createApp();

  it("returns 400 when x-org-id is missing", async () => {
    const res = await request(app)
      .get("/test")
      .set("x-user-id", "user_123")
      .set("x-run-id", "run_123");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required header: x-org-id");
  });

  it("returns 400 when x-user-id is missing", async () => {
    const res = await request(app)
      .get("/test")
      .set("x-org-id", "org_123")
      .set("x-run-id", "run_123");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required header: x-user-id");
  });

  it("returns 400 when x-run-id is missing", async () => {
    const res = await request(app)
      .get("/test")
      .set("x-org-id", "org_123")
      .set("x-user-id", "user_123");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required header: x-run-id");
  });

  it("returns 400 when all headers are missing", async () => {
    const res = await request(app).get("/test");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required header: x-org-id");
  });

  it("passes through when all headers are present", async () => {
    const res = await request(app)
      .get("/test")
      .set("x-org-id", "org_123")
      .set("x-user-id", "user_456")
      .set("x-run-id", "run_789");

    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe("org_123");
    expect(res.body.userId).toBe("user_456");
    expect(res.body.runId).toBe("run_789");
  });

  it("skips validation for /health", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("skips validation for /openapi.json", async () => {
    const res = await request(app).get("/openapi.json");

    expect(res.status).toBe(200);
  });

  it("skips validation for /webhooks/stripe", async () => {
    const res = await request(app).post("/webhooks/stripe");

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});
