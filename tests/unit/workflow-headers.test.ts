import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { requireIdentityHeaders } from "../../src/middleware/identityHeaders";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(requireIdentityHeaders);

  app.get("/test", (_req, res) =>
    res.json({
      orgId: res.locals.orgId,
      userId: res.locals.userId,
      runId: res.locals.runId,
      campaignId: res.locals.campaignId ?? null,
      brandId: res.locals.brandId ?? null,
      workflowName: res.locals.workflowName ?? null,
    })
  );

  return app;
}

describe("workflow tracking headers (optional)", () => {
  const app = createApp();

  const requiredHeaders = {
    "x-org-id": "org_123",
    "x-user-id": "user_456",
    "x-run-id": "run_789",
  };

  it("extracts all three workflow headers when present", async () => {
    const res = await request(app)
      .get("/test")
      .set(requiredHeaders)
      .set("x-campaign-id", "camp_abc")
      .set("x-brand-id", "brand_xyz")
      .set("x-workflow-name", "outreach-dag");

    expect(res.status).toBe(200);
    expect(res.body.campaignId).toBe("camp_abc");
    expect(res.body.brandId).toBe("brand_xyz");
    expect(res.body.workflowName).toBe("outreach-dag");
  });

  it("returns null for workflow headers when absent", async () => {
    const res = await request(app).get("/test").set(requiredHeaders);

    expect(res.status).toBe(200);
    expect(res.body.campaignId).toBeNull();
    expect(res.body.brandId).toBeNull();
    expect(res.body.workflowName).toBeNull();
  });

  it("handles partial workflow headers (only campaign)", async () => {
    const res = await request(app)
      .get("/test")
      .set(requiredHeaders)
      .set("x-campaign-id", "camp_only");

    expect(res.status).toBe(200);
    expect(res.body.campaignId).toBe("camp_only");
    expect(res.body.brandId).toBeNull();
    expect(res.body.workflowName).toBeNull();
  });

  it("does not break when required headers are missing (still returns 400)", async () => {
    const res = await request(app)
      .get("/test")
      .set("x-campaign-id", "camp_abc")
      .set("x-brand-id", "brand_xyz");

    expect(res.status).toBe(400);
  });
});
