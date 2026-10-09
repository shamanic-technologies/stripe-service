import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { TEST_API_KEY, TEST_ORG_ID } from "../helpers/mocks";

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
vi.mock("../../src/lib/key-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/key-client")>();
  return {
    ...actual,
    resolvePlatformKey: vi.fn().mockResolvedValue({ key: "sk_test_platform" }),
  };
});

const revolutMock = vi.hoisted(() => ({
  listCustomerPaymentMethods: vi.fn(),
  deleteCustomerPaymentMethod: vi.fn(),
}));
vi.mock("../../src/lib/revolut-client", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/lib/revolut-client")
  >();
  return { ...actual, ...revolutMock };
});

const billingMock = vi.hoisted(() => ({ reportPaymentMethodLost: vi.fn() }));
vi.mock("../../src/lib/billing-client", () => billingMock);

const emailMock = vi.hoisted(() => ({ sendStaffEmail: vi.fn() }));
vi.mock("../../src/lib/transactional-email-client", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/lib/transactional-email-client")
  >();
  return { ...actual, ...emailMock };
});

import { createTestApp } from "../helpers/test-app";
import { RevolutApiError } from "../../src/lib/revolut-client";

const app = createTestApp();
const headers = { "X-API-Key": TEST_API_KEY };
const path = `/internal/payment_methods/by-org/${TEST_ORG_ID}`;

const CARD = {
  id: "6ac8c231-3b1a-a5de-bf93-90d47ad77d06",
  type: "card",
  saved_for: "merchant",
  brand: "mastercard",
  last_four: "6003",
  expiry_month: 4,
  expiry_year: 2033,
};

function notFound() {
  return new RevolutApiError(404, '{"code":"not_found"}', "Revolut 404");
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearQueues();
  revolutMock.listCustomerPaymentMethods.mockReset();
  revolutMock.deleteCustomerPaymentMethod.mockReset();
  billingMock.reportPaymentMethodLost.mockResolvedValue(undefined);
  emailMock.sendStaffEmail.mockResolvedValue(undefined);
  (stripeMock.paymentMethods as Record<string, unknown>).detach = vi.fn();
});

describe("DELETE /internal/payment_methods/by-org/:orgId — Revolut org", () => {
  function pinnedToRevolut(customerId: string | null = "cus-rev-1") {
    dbMock.queueSelect("org_acquirers", [{ acquirer: "revolut", customerId }]);
  }

  it("deletes every saved Revolut method and reports the acquirer and ids", async () => {
    pinnedToRevolut();
    const second = { id: "pm-rev-2", type: "card", saved_for: "merchant" };
    revolutMock.listCustomerPaymentMethods
      .mockResolvedValueOnce([CARD, second])
      .mockResolvedValueOnce([]);
    revolutMock.deleteCustomerPaymentMethod.mockResolvedValue(undefined);

    const res = await request(app).delete(path).set(headers);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      object: "payment_methods_removed",
      org_id: TEST_ORG_ID,
      acquirer: "revolut",
      customer: "cus-rev-1",
      detached: [CARD.id, "pm-rev-2"],
      already_detached: [],
    });
    expect(revolutMock.deleteCustomerPaymentMethod.mock.calls).toEqual([
      ["cus-rev-1", CARD.id],
      ["cus-rev-1", "pm-rev-2"],
    ]);
    expect(stripeMock.paymentMethods.list).not.toHaveBeenCalled();
  });

  it("fires the 'no chargeable card left' signal to billing once, and emails staff", async () => {
    pinnedToRevolut();
    revolutMock.listCustomerPaymentMethods
      .mockResolvedValueOnce([CARD])
      .mockResolvedValueOnce([]);
    revolutMock.deleteCustomerPaymentMethod.mockResolvedValue(undefined);

    await request(app).delete(path).set(headers).expect(200);

    expect(billingMock.reportPaymentMethodLost).toHaveBeenCalledTimes(1);
    expect(billingMock.reportPaymentMethodLost).toHaveBeenCalledWith(TEST_ORG_ID);
    expect(emailMock.sendStaffEmail).toHaveBeenCalledTimes(1);
    const mail = emailMock.sendStaffEmail.mock.calls[0][0];
    expect(mail.eventType).toBe("payment_method_removed");
    expect(mail.metadata.paymentMethodLabel).toBe(
      "Mastercard ending 6003, expires 04/2033"
    );
    expect(mail.metadata.cardsRemaining).toBe("0");
  });

  it("a replay that finds the method already gone signals nothing", async () => {
    pinnedToRevolut();
    revolutMock.listCustomerPaymentMethods
      .mockResolvedValueOnce([CARD])
      .mockResolvedValueOnce([]);
    revolutMock.deleteCustomerPaymentMethod.mockRejectedValue(notFound());

    const res = await request(app).delete(path).set(headers).expect(200);

    expect(res.body.detached).toEqual([]);
    expect(res.body.already_detached).toEqual([CARD.id]);
    expect(billingMock.reportPaymentMethodLost).not.toHaveBeenCalled();
    expect(emailMock.sendStaffEmail).not.toHaveBeenCalled();
  });

  it("nothing held is a 200 with nothing removed and no signal", async () => {
    pinnedToRevolut();
    revolutMock.listCustomerPaymentMethods.mockResolvedValue([]);

    const res = await request(app).delete(path).set(headers).expect(200);

    expect(res.body).toMatchObject({ acquirer: "revolut", detached: [], already_detached: [] });
    expect(revolutMock.deleteCustomerPaymentMethod).not.toHaveBeenCalled();
    expect(billingMock.reportPaymentMethodLost).not.toHaveBeenCalled();
  });

  it("a Revolut org with no customer yet has nothing to remove", async () => {
    pinnedToRevolut(null);

    const res = await request(app).delete(path).set(headers).expect(200);

    expect(res.body).toEqual({
      object: "payment_methods_removed",
      org_id: TEST_ORG_ID,
      acquirer: "revolut",
      customer: null,
      detached: [],
      already_detached: [],
    });
    expect(revolutMock.listCustomerPaymentMethods).not.toHaveBeenCalled();
  });

  it("fails loud when a method is still there after the removal", async () => {
    pinnedToRevolut();
    revolutMock.listCustomerPaymentMethods
      .mockResolvedValueOnce([CARD])
      .mockResolvedValueOnce([CARD]);
    revolutMock.deleteCustomerPaymentMethod.mockResolvedValue(undefined);

    const res = await request(app).delete(path).set(headers);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(billingMock.reportPaymentMethodLost).not.toHaveBeenCalled();
  });

  it("fails loud when the acquirer refuses the delete", async () => {
    pinnedToRevolut();
    revolutMock.listCustomerPaymentMethods.mockResolvedValueOnce([CARD]);
    revolutMock.deleteCustomerPaymentMethod.mockRejectedValue(
      new RevolutApiError(500, "boom", "Revolut 500")
    );

    const res = await request(app).delete(path).set(headers);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(billingMock.reportPaymentMethodLost).not.toHaveBeenCalled();
  });

  it("a billing-service failure never fails the removal the customer asked for", async () => {
    pinnedToRevolut();
    revolutMock.listCustomerPaymentMethods
      .mockResolvedValueOnce([CARD])
      .mockResolvedValueOnce([]);
    revolutMock.deleteCustomerPaymentMethod.mockResolvedValue(undefined);
    billingMock.reportPaymentMethodLost.mockRejectedValue(new Error("down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app).delete(path).set(headers).expect(200);

    expect(res.body.detached).toEqual([CARD.id]);
  });
});

describe("DELETE /internal/payment_methods/by-org/:orgId — Stripe org (unchanged)", () => {
  it("detaches every Stripe method and touches neither Revolut nor billing inline", async () => {
    // No pin row = Stripe.
    dbMock.queueSelect("customers", [{ id: "cus_123" }]);
    stripeMock.paymentMethods.list.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { id: "pm_card" };
        yield { id: "pm_link" };
      },
    });
    (stripeMock.paymentMethods as Record<string, ReturnType<typeof vi.fn>>).detach
      .mockResolvedValue({});

    const res = await request(app).delete(path).set(headers).expect(200);

    expect(res.body).toEqual({
      object: "payment_methods_removed",
      org_id: TEST_ORG_ID,
      acquirer: "stripe",
      customer: "cus_123",
      detached: ["pm_card", "pm_link"],
      already_detached: [],
    });
    expect(revolutMock.listCustomerPaymentMethods).not.toHaveBeenCalled();
    expect(billingMock.reportPaymentMethodLost).not.toHaveBeenCalled();
  });

  it("an org with no Stripe customer is still a 200 with nothing removed", async () => {
    const res = await request(app).delete(path).set(headers).expect(200);
    expect(res.body).toMatchObject({ acquirer: "stripe", customer: null, detached: [] });
  });
});
