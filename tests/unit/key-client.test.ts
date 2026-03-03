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

  it("returns decrypted key and keySource on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ key: "sk_live_resolved123", keySource: "platform" }),
    });

    const result = await getDecryptedStripeKey("org_123", "user_456", { method: "GET", path: "/products/:productId" });

    expect(result).toEqual({ key: "sk_live_resolved123", keySource: "platform" });
    expect(mockFetch).toHaveBeenCalledOnce();
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/keys/stripe/decrypt");
    expect(url).toContain("orgId=org_123");
    expect(url).toContain("userId=user_456");
  });

  it("returns org keySource when org key is used", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ key: "sk_live_org_key", keySource: "org" }),
    });

    const result = await getDecryptedStripeKey("org_123", "user_456", { method: "GET", path: "/products/:productId" });

    expect(result.keySource).toBe("org");
  });

  it("throws clear error on 404 (no key configured)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "Key not configured",
    });

    await expect(getDecryptedStripeKey("org_missing", "user_456", { method: "GET", path: "/products/:productId" })).rejects.toThrow(
      "No Stripe key configured for org 'org_missing'"
    );
  });

  it("throws generic error on other non-ok responses", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal error",
    });

    await expect(getDecryptedStripeKey("org_broken", "user_456", { method: "GET", path: "/products/:productId" })).rejects.toThrow(
      "key-service GET /keys/stripe/decrypt failed: 500"
    );
  });

  it("encodes orgId and userId in URL", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ key: "sk_test_123", keySource: "platform" }),
    });

    await getDecryptedStripeKey("org with spaces", "user with spaces", { method: "GET", path: "/products/:productId" });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("orgId=org%20with%20spaces");
    expect(url).toContain("userId=user%20with%20spaces");
  });

  it("sends x-api-key header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ key: "sk_test_123", keySource: "platform" }),
    });

    await getDecryptedStripeKey("org_123", "user_456", { method: "GET", path: "/products/:productId" });

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.headers).toEqual(
      expect.objectContaining({ "x-api-key": expect.any(String) })
    );
  });

  it("sends X-Caller-Service, X-Caller-Method, X-Caller-Path headers", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ key: "sk_test_123", keySource: "platform" }),
    });

    await getDecryptedStripeKey("org_123", "user_456", { method: "POST", path: "/checkout/create" });

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers["x-caller-service"]).toBe("stripe");
    expect(headers["x-caller-method"]).toBe("POST");
    expect(headers["x-caller-path"]).toBe("/checkout/create");
  });
});
