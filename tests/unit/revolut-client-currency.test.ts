import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/lib/key-client", () => ({
  resolvePlatformKey: vi.fn().mockResolvedValue("sk_test_revolut"),
}));

import { createOrder } from "../../src/lib/revolut-client";

/**
 * Revolut's Merchant API accepts only an UPPERCASE ISO 4217 code. Callers speak
 * Stripe's lowercase ("usd", billing-service pins it), and a lowercase code is a
 * 400 `'currency' is invalid` — every off-session Revolut charge failed on it
 * (prod incident 2026-10-06). The client boundary normalises, so no caller can
 * reintroduce it.
 */
describe("revolut-client createOrder currency", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: "ord-1", state: "pending" }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sentBody(): Record<string, unknown> {
    const init = fetchMock.mock.calls[0][1] as { body: string };
    return JSON.parse(init.body);
  }

  it("sends uppercase USD to Revolut when given lowercase usd", async () => {
    await createOrder({ amount: 9900, currency: "usd", customerId: "cus-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://merchant.revolut.com/api/orders");
    expect(sentBody().currency).toBe("USD");
    expect(sentBody().customer).toEqual({ id: "cus-1" });
  });

  it("leaves an already-uppercase code untouched", async () => {
    await createOrder({ amount: 100, currency: "EUR" });
    expect(sentBody().currency).toBe("EUR");
  });
});
