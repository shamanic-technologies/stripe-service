import { describe, it, expect, vi } from "vitest";
import type Stripe from "stripe";
import { detachAllPaymentMethods } from "../../src/lib/remove-payment-methods";

/**
 * The SDK's list is an auto-paginating async iterable. Tests iterate it, so the
 * stub is one too — a plain array would pass here and diverge from production.
 */
function stripeWith(
  methods: Array<{ id: string; type?: string }>,
  detach: (id: string) => Promise<unknown> = async () => ({})
) {
  const list = vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      for (const m of methods) yield m;
    },
  }));
  const detachFn = vi.fn((id: string) => detach(id));
  return {
    stripe: { paymentMethods: { list, detach: detachFn } } as unknown as Stripe,
    list,
    detachFn,
  };
}

describe("detachAllPaymentMethods", () => {
  it("detaches EVERY method, not only the default", async () => {
    const { stripe, detachFn } = stripeWith([
      { id: "pm_default", type: "card" },
      { id: "pm_second", type: "card" },
      { id: "pm_link", type: "link" },
    ]);

    expect(await detachAllPaymentMethods(stripe, "cus_1")).toEqual({
      detached: ["pm_default", "pm_second", "pm_link"],
      alreadyDetached: [],
    });
    expect(detachFn.mock.calls.map((c) => c[0])).toEqual([
      "pm_default",
      "pm_second",
      "pm_link",
    ]);
  });

  it("lists with NO type filter — a wallet method is still a method we hold", async () => {
    const { stripe, list } = stripeWith([{ id: "pm_1" }]);
    await detachAllPaymentMethods(stripe, "cus_1");
    expect(list).toHaveBeenCalledWith({ customer: "cus_1", limit: 100 });
    expect(list.mock.calls[0][0]).not.toHaveProperty("type");
  });

  it("a customer holding nothing is a clean empty answer, not an error", async () => {
    const { stripe, detachFn } = stripeWith([]);
    expect(await detachAllPaymentMethods(stripe, "cus_empty")).toEqual({
      detached: [],
      alreadyDetached: [],
    });
    expect(detachFn).not.toHaveBeenCalled();
  });

  it("counts an already-gone method apart, and keeps going", async () => {
    const gone = Object.assign(new Error("No such PaymentMethod"), {
      code: "resource_missing",
      statusCode: 404,
    });
    const { stripe } = stripeWith(
      [{ id: "pm_gone" }, { id: "pm_live" }],
      async (id) => {
        if (id === "pm_gone") throw gone;
        return {};
      }
    );

    expect(await detachAllPaymentMethods(stripe, "cus_1")).toEqual({
      detached: ["pm_live"],
      alreadyDetached: ["pm_gone"],
    });
  });

  it("fails loud on any other Stripe error — a caller must retry, not report a removal that did not happen", async () => {
    const boom = Object.assign(new Error("Stripe is down"), {
      code: "api_error",
      statusCode: 500,
    });
    const { stripe } = stripeWith([{ id: "pm_1" }], async () => {
      throw boom;
    });

    await expect(detachAllPaymentMethods(stripe, "cus_1")).rejects.toBe(boom);
  });
});
