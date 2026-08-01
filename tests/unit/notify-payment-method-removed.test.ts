import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock, stripeMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeDbMock, makeStripeMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi), stripeMock: makeStripeMock(vi) };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));
vi.mock("../../src/lib/transactional-email-client", () => ({
  PAYMENT_METHOD_REMOVED_EVENT_TYPE: "payment_method_removed",
  sendStaffEmail: vi.fn(async () => {}),
}));

import {
  isPaymentMethodDetachedEvent,
  notifyPaymentMethodRemoved,
  describePaymentMethod,
} from "../../src/lib/notify-payment-method-removed";
import { sendStaffEmail } from "../../src/lib/transactional-email-client";

const ORG_ID = "a2bc915a-7430-4842-a911-a29d3430d4ea";
const CUSTOMER_ID = "cus_Uv6pJnKE15nmHB";

function asyncIter<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const it of items) yield it;
    },
  };
}

function cards(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `pm_card_${i}`,
    object: "payment_method",
    type: "card",
  }));
}

/**
 * The real prod detach event (`evt_1TzQD1EnlXMXdaZao55dx2VF`, 2026-07-31),
 * trimmed. Note `data.object.customer` is null and the previous owner lives
 * only in `data.previous_attributes.customer` — that is what this side-effect
 * has to read.
 */
function detachedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1TzQD1EnlXMXdaZao55dx2VF",
    type: "payment_method.detached",
    created: 1785541883,
    livemode: true,
    data: {
      object: {
        id: "pm_1TvGg3EnlXMXdaZa1cojiTAy",
        object: "payment_method",
        type: "link",
        link: { email: "imenez@gmail.com" },
        customer: null,
        billing_details: { name: "SARAH JIMENEZ", email: "imenez@gmail.com" },
        ...overrides,
      },
      previous_attributes: { customer: CUSTOMER_ID },
    },
  } as never;
}

const resolveStripe = async () => stripeMock as never;

function metadataOfLastSend(): Record<string, string> {
  const call = vi.mocked(sendStaffEmail).mock.calls.at(-1);
  return (call?.[0] as { metadata: Record<string, string> }).metadata;
}

function mirrorHolds(rows: Record<string, unknown>[]): void {
  dbMock.clearQueues();
  dbMock.queueSelect("customers", rows);
}

beforeEach(() => {
  vi.clearAllMocks();
  stripeMock.customers.retrieve.mockResolvedValue({
    id: CUSTOMER_ID,
    object: "customer",
  });
  stripeMock.paymentMethods.list.mockReturnValue(asyncIter(cards(1)));
  mirrorHolds([{ orgId: ORG_ID, email: "imenez@gmail.com", name: "Ivan" }]);
});

describe("isPaymentMethodDetachedEvent", () => {
  it("matches only the detach event", () => {
    expect(isPaymentMethodDetachedEvent("payment_method.detached")).toBe(true);
    expect(isPaymentMethodDetachedEvent("payment_method.attached")).toBe(false);
    expect(isPaymentMethodDetachedEvent("customer.updated")).toBe(false);
  });
});

describe("notifyPaymentMethodRemoved", () => {
  it("attributes the removal through previous_attributes, since Stripe nulls the customer on the detached object", async () => {
    const sent = await notifyPaymentMethodRemoved(
      detachedEvent(),
      resolveStripe
    );

    expect(sent).toBe(true);
    expect(stripeMock.customers.retrieve).toHaveBeenCalledWith(CUSTOMER_ID);
    expect(stripeMock.paymentMethods.list).toHaveBeenCalledWith({
      customer: CUSTOMER_ID,
      type: "card",
      limit: 100,
    });
    expect(sendStaffEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendStaffEmail).mock.calls[0][0]).toMatchObject({
      eventType: "payment_method_removed",
      orgId: ORG_ID,
    });
  });

  it("still attributes the removal when Stripe leaves the customer on the object", async () => {
    const event = detachedEvent({ customer: CUSTOMER_ID });
    (event as unknown as { data: { previous_attributes?: unknown } }).data
      .previous_attributes = {};

    expect(await notifyPaymentMethodRemoved(event, resolveStripe)).toBe(true);
    expect(stripeMock.customers.retrieve).toHaveBeenCalledWith(CUSTOMER_ID);
  });

  it("names the organisation, the payment method and the cards left", async () => {
    stripeMock.paymentMethods.list.mockReturnValue(asyncIter(cards(2)));

    await notifyPaymentMethodRemoved(detachedEvent(), resolveStripe);

    const metadata = metadataOfLastSend();
    expect(metadata.orgId).toBe(ORG_ID);
    expect(metadata.customerId).toBe(CUSTOMER_ID);
    expect(metadata.paymentMethodId).toBe("pm_1TvGg3EnlXMXdaZa1cojiTAy");
    expect(metadata.paymentMethodLabel).toBe("Link (imenez@gmail.com)");
    expect(metadata.cardsRemaining).toBe("2");
    expect(metadata.cardsRemainingLabel).toBe("2 chargeable cards left");
    expect(metadata.eventId).toBe("evt_1TzQD1EnlXMXdaZao55dx2VF");
    expect(metadata.removedAt).toBe("2026-07-31T23:51:23.000Z");
  });

  it("says auto top-up is broken when the last chargeable card is gone", async () => {
    stripeMock.paymentMethods.list.mockReturnValue(asyncIter([]));

    await notifyPaymentMethodRemoved(detachedEvent(), resolveStripe);

    const metadata = metadataOfLastSend();
    expect(metadata.cardsRemaining).toBe("0");
    expect(metadata.cardsRemainingLabel).toBe("no chargeable card left");
    expect(metadata.impact).toMatch(/automatic top-up will fail/i);
  });

  it("notifies on a routine detach that leaves a card behind", async () => {
    await notifyPaymentMethodRemoved(detachedEvent(), resolveStripe);

    const metadata = metadataOfLastSend();
    expect(metadata.cardsRemainingLabel).toBe("1 chargeable card left");
    expect(metadata.impact).toMatch(/can still run/i);
  });

  it("counts only card payment methods, never Link or wallets", async () => {
    await notifyPaymentMethodRemoved(detachedEvent(), resolveStripe);

    expect(stripeMock.paymentMethods.list).toHaveBeenCalledWith(
      expect.objectContaining({ type: "card" })
    );
  });

  it("sends nothing when the customer maps to no organisation of ours", async () => {
    mirrorHolds([]);

    const sent = await notifyPaymentMethodRemoved(
      detachedEvent(),
      resolveStripe
    );

    expect(sent).toBe(false);
    expect(sendStaffEmail).not.toHaveBeenCalled();
    expect(stripeMock.customers.retrieve).not.toHaveBeenCalled();
  });

  it("sends nothing when the org row carries the 'unknown' tenant sentinel", async () => {
    mirrorHolds([{ orgId: "unknown", email: null, name: null }]);

    expect(await notifyPaymentMethodRemoved(detachedEvent(), resolveStripe)).toBe(
      false
    );
    expect(sendStaffEmail).not.toHaveBeenCalled();
  });

  it("sends nothing when the event carries no previous customer", async () => {
    const event = detachedEvent();
    (event as unknown as { data: { previous_attributes?: unknown } }).data
      .previous_attributes = {};

    expect(await notifyPaymentMethodRemoved(event, resolveStripe)).toBe(false);
    expect(sendStaffEmail).not.toHaveBeenCalled();
  });

  // Org teardown deletes the Stripe customer, which detaches every payment
  // method it held. That must not produce a burst of alarming emails about an
  // organisation that no longer exists.
  it("sends nothing when the customer was deleted at Stripe (org teardown)", async () => {
    stripeMock.customers.retrieve.mockResolvedValue({
      id: CUSTOMER_ID,
      object: "customer",
      deleted: true,
    });

    expect(
      await notifyPaymentMethodRemoved(detachedEvent(), resolveStripe)
    ).toBe(false);
    expect(sendStaffEmail).not.toHaveBeenCalled();
    expect(stripeMock.paymentMethods.list).not.toHaveBeenCalled();
  });

  it("sends nothing when the customer is already gone from Stripe entirely", async () => {
    stripeMock.customers.retrieve.mockRejectedValue(
      Object.assign(new Error("No such customer"), { code: "resource_missing" })
    );

    expect(
      await notifyPaymentMethodRemoved(detachedEvent(), resolveStripe)
    ).toBe(false);
    expect(sendStaffEmail).not.toHaveBeenCalled();
  });

  it("swallows an email-service failure so the webhook still succeeds", async () => {
    vi.mocked(sendStaffEmail).mockRejectedValueOnce(
      new Error("transactional-email-service POST /send failed: 500")
    );

    await expect(
      notifyPaymentMethodRemoved(detachedEvent(), resolveStripe)
    ).resolves.toBe(false);
  });

  it("swallows a missing email-service configuration", async () => {
    vi.mocked(sendStaffEmail).mockRejectedValueOnce(
      new Error("transactional-email-service is not configured")
    );

    await expect(
      notifyPaymentMethodRemoved(detachedEvent(), resolveStripe)
    ).resolves.toBe(false);
  });

  it("swallows a failure to resolve the platform Stripe key", async () => {
    await expect(
      notifyPaymentMethodRemoved(detachedEvent(), async () => {
        throw new Error("key-service unavailable");
      })
    ).resolves.toBe(false);
    expect(sendStaffEmail).not.toHaveBeenCalled();
  });

  it("swallows a Stripe failure", async () => {
    stripeMock.customers.retrieve.mockRejectedValue(new Error("Stripe is down"));

    await expect(
      notifyPaymentMethodRemoved(detachedEvent(), resolveStripe)
    ).resolves.toBe(false);
  });

  it("swallows a database failure", async () => {
    dbMock.db.select.mockImplementationOnce(() => {
      throw new Error("Neon is asleep");
    });

    await expect(
      notifyPaymentMethodRemoved(detachedEvent(), resolveStripe)
    ).resolves.toBe(false);
  });
});

describe("describePaymentMethod", () => {
  it("identifies a card by brand, last4 and expiry", () => {
    expect(
      describePaymentMethod({
        id: "pm_1",
        type: "card",
        card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2029 },
      } as never)
    ).toBe("Visa ending 4242, expires 04/2029");
  });

  it("identifies a Link payment method by its email", () => {
    expect(
      describePaymentMethod({
        id: "pm_2",
        type: "link",
        link: { email: "imenez@gmail.com" },
      } as never)
    ).toBe("Link (imenez@gmail.com)");
  });

  it("identifies a bank account by bank name and last4", () => {
    expect(
      describePaymentMethod({
        id: "pm_3",
        type: "us_bank_account",
        us_bank_account: { bank_name: "STRIPE TEST BANK", last4: "6789" },
      } as never)
    ).toBe("STRIPE TEST BANK ending 6789");
  });

  it("falls back to the payment-method type for anything else", () => {
    expect(
      describePaymentMethod({ id: "pm_4", type: "cashapp" } as never)
    ).toBe("Cashapp");
    expect(
      describePaymentMethod({
        id: "pm_5",
        type: "sepa_debit",
        billing_details: { email: "a@b.com" },
      } as never)
    ).toBe("Sepa Debit (a@b.com)");
  });
});
