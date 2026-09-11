import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { authHeaders } from "../helpers/mocks";

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
  isResourceMissing: () => false,
}));
vi.mock("../../src/lib/resolve-stripe-key", () => ({
  resolveStripeKey: vi.fn().mockResolvedValue({ key: "sk_test_xxx", keySource: "platform" }),
}));

import { createTestApp } from "../helpers/test-app";
import {
  CARD_UPDATE_CONFIGURATION_ENV,
  INVOICE_HISTORY_CONFIGURATION_ENV,
} from "../../src/lib/portal-session";

const app = createTestApp();

const portalSession = {
  id: "bps_test",
  object: "billing_portal.session",
  customer: "cus_x",
  url: "https://billing.stripe.com/x",
  return_url: "https://app.example.com",
  created: 1700000000,
  livemode: false,
};

describe("POST /v1/billing_portal/sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMock.billingPortal.sessions.create.mockReset();
    vi.stubEnv(CARD_UPDATE_CONFIGURATION_ENV, "bpc_card_update");
    vi.stubEnv(INVOICE_HISTORY_CONFIGURATION_ENV, "bpc_invoices");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates a billing portal session", async () => {
    stripeMock.billingPortal.sessions.create.mockResolvedValueOnce({
      id: "bps_test",
      object: "billing_portal.session",
      customer: "cus_x",
      url: "https://billing.stripe.com/x",
      return_url: "https://app.example.com",
      created: 1700000000,
      livemode: false,
    });

    const res = await request(app)
      .post("/v1/billing_portal/sessions")
      .set(authHeaders())
      .send({ customer: "cus_x", return_url: "https://app.example.com" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("bps_test");
    expect(res.body.url).toBe("https://billing.stripe.com/x");
    expect(stripeMock.billingPortal.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_x", return_url: "https://app.example.com" }),
      undefined
    );
  });

  it("opens invoice history on the configuration that cannot manage cards", async () => {
    stripeMock.billingPortal.sessions.create.mockResolvedValueOnce(portalSession);

    const res = await request(app)
      .post("/v1/billing_portal/sessions")
      .set(authHeaders())
      .send({ customer: "cus_x", return_url: "https://app.example.com" });

    expect(res.status).toBe(200);
    const params = stripeMock.billingPortal.sessions.create.mock.calls[0][0];
    expect(params.configuration).toBe("bpc_invoices");
    expect(params.flow_data).toBeUndefined();
  });

  it("opens the add/replace-a-card flow when the caller asks for it", async () => {
    stripeMock.billingPortal.sessions.create.mockResolvedValueOnce(portalSession);

    const res = await request(app)
      .post("/v1/billing_portal/sessions")
      .set(authHeaders())
      .send({
        customer: "cus_x",
        return_url: "https://app.example.com",
        flow_data: { type: "payment_method_update" },
      });

    expect(res.status).toBe(200);
    const params = stripeMock.billingPortal.sessions.create.mock.calls[0][0];
    expect(params.configuration).toBe("bpc_card_update");
    expect(params.flow_data).toEqual({
      type: "payment_method_update",
      after_completion: {
        type: "redirect",
        redirect: { return_url: "https://app.example.com" },
      },
    });
  });

  it("refuses a caller-supplied configuration", async () => {
    const res = await request(app)
      .post("/v1/billing_portal/sessions")
      .set(authHeaders())
      .send({ customer: "cus_x", configuration: "bpc_full_portal" });

    expect(res.status).toBe(400);
    expect(stripeMock.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it("refuses a flow it does not support", async () => {
    const res = await request(app)
      .post("/v1/billing_portal/sessions")
      .set(authHeaders())
      .send({ customer: "cus_x", flow_data: { type: "subscription_cancel" } });

    expect(res.status).toBe(400);
    expect(stripeMock.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it("fails loud when the pinned configuration is missing", async () => {
    vi.stubEnv(INVOICE_HISTORY_CONFIGURATION_ENV, "");

    const res = await request(app)
      .post("/v1/billing_portal/sessions")
      .set(authHeaders())
      .send({ customer: "cus_x" });

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(stripeMock.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it("requires customer in body", async () => {
    const res = await request(app)
      .post("/v1/billing_portal/sessions")
      .set(authHeaders())
      .send({ return_url: "https://app.example.com" });
    expect(res.status).toBe(400);
  });
});
