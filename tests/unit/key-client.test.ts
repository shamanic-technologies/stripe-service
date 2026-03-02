import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must mock fetch before importing key-client
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { getDecryptedStripeKey } from "../../src/lib/key-client";

describe("key-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns decrypted key on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ provider: "stripe", key: "sk_live_resolved123" }),
    });

    const key = await getDecryptedStripeKey("app_123", { method: "GET", path: "/products/:productId" });

    expect(key).toBe("sk_live_resolved123");
    expect(mockFetch).toHaveBeenCalledOnce();
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/internal/app-keys/stripe/decrypt");
    expect(url).toContain("appId=app_123");
  });

  it("throws clear error on 404 (no key configured)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "Key not configured",
    });

    await expect(getDecryptedStripeKey("app_missing", { method: "GET", path: "/products/:productId" })).rejects.toThrow(
      "No Stripe key configured for appId 'app_missing'"
    );
  });

  it("throws generic error on other non-ok responses", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal error",
    });

    await expect(getDecryptedStripeKey("app_broken", { method: "GET", path: "/products/:productId" })).rejects.toThrow(
      "key-service GET /internal/app-keys/stripe/decrypt failed: 500"
    );
  });

  it("encodes appId in URL", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ provider: "stripe", key: "sk_test_123" }),
    });

    await getDecryptedStripeKey("app with spaces", { method: "GET", path: "/products/:productId" });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("appId=app%20with%20spaces");
  });

  it("sends x-api-key header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ provider: "stripe", key: "sk_test_123" }),
    });

    await getDecryptedStripeKey("app_123", { method: "GET", path: "/products/:productId" });

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.headers).toEqual(
      expect.objectContaining({ "x-api-key": expect.any(String) })
    );
  });

  it("sends X-Caller-Service, X-Caller-Method, X-Caller-Path headers", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ provider: "stripe", key: "sk_test_123" }),
    });

    await getDecryptedStripeKey("app_123", { method: "POST", path: "/checkout/create" });

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers["x-caller-service"]).toBe("stripe");
    expect(headers["x-caller-method"]).toBe("POST");
    expect(headers["x-caller-path"]).toBe("/checkout/create");
  });
});
