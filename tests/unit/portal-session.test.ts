import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import {
  CARD_UPDATE_CONFIGURATION_ENV,
  INVOICE_HISTORY_CONFIGURATION_ENV,
  cardUpdatePortalParams,
  invoiceHistoryPortalParams,
} from "../../src/lib/portal-session";

beforeEach(() => {
  vi.stubEnv(CARD_UPDATE_CONFIGURATION_ENV, "bpc_card_update");
  vi.stubEnv(INVOICE_HISTORY_CONFIGURATION_ENV, "bpc_invoices");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cardUpdatePortalParams", () => {
  it("scopes the session to the add/replace-a-card flow on a pinned configuration", () => {
    expect(
      cardUpdatePortalParams({
        customer: "cus_x",
        return_url: "https://dashboard.example/billing",
      })
    ).toEqual({
      customer: "cus_x",
      return_url: "https://dashboard.example/billing",
      configuration: "bpc_card_update",
      flow_data: {
        type: "payment_method_update",
        after_completion: {
          type: "redirect",
          redirect: { return_url: "https://dashboard.example/billing" },
        },
      },
    });
  });

  it("omits the redirect when there is nowhere to return to", () => {
    const params = cardUpdatePortalParams({ customer: "cus_x" });
    expect(params.flow_data).toEqual({ type: "payment_method_update" });
    expect(params.return_url).toBeUndefined();
  });

  it("fails loud when the configuration is not set, never falls back to the full portal", () => {
    vi.stubEnv(CARD_UPDATE_CONFIGURATION_ENV, "");
    expect(() => cardUpdatePortalParams({ customer: "cus_x" })).toThrow(
      new RegExp(CARD_UPDATE_CONFIGURATION_ENV)
    );
  });
});

describe("invoiceHistoryPortalParams", () => {
  it("pins the configuration that has payment-method management disabled", () => {
    expect(
      invoiceHistoryPortalParams({
        customer: "cus_x",
        return_url: "https://dashboard.example/billing",
      })
    ).toEqual({
      customer: "cus_x",
      return_url: "https://dashboard.example/billing",
      configuration: "bpc_invoices",
    });
  });

  it("never carries a flow", () => {
    expect(
      invoiceHistoryPortalParams({ customer: "cus_x" })
    ).not.toHaveProperty("flow_data");
  });

  it("fails loud when the configuration is not set", () => {
    delete process.env[INVOICE_HISTORY_CONFIGURATION_ENV];
    expect(() => invoiceHistoryPortalParams({ customer: "cus_x" })).toThrow(
      new RegExp(INVOICE_HISTORY_CONFIGURATION_ENV)
    );
  });
});
