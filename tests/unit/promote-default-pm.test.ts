import { describe, it, expect, vi, beforeEach } from "vitest";
import { TEST_ORG_ID } from "../helpers/mocks";

const { dbMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

import { promoteDefaultPaymentMethod } from "../../src/lib/promote-default-pm";

type StripeMock = {
  customers: { retrieve: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  paymentIntents: { retrieve: ReturnType<typeof vi.fn> };
  setupIntents: { retrieve: ReturnType<typeof vi.fn> };
  paymentMethods: { retrieve: ReturnType<typeof vi.fn>; attach: ReturnType<typeof vi.fn> };
};

function makeStripe(): StripeMock {
  return {
    customers: { retrieve: vi.fn(), update: vi.fn() },
    paymentIntents: { retrieve: vi.fn() },
    setupIntents: { retrieve: vi.fn() },
    paymentMethods: { retrieve: vi.fn(), attach: vi.fn() },
  };
}

const baseEvent = {
  api_version: "2024-12-18",
  livemode: false,
  created: 1700000000,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearCaptured();
});

describe("promoteDefaultPaymentMethod — dispatch", () => {
  it("ignores non-relevant event types", async () => {
    const stripe = makeStripe();
    await promoteDefaultPaymentMethod(
      {
        ...baseEvent,
        id: "evt_x",
        type: "customer.created",
        data: { object: { id: "cus_1", object: "customer" } },
      } as never,
      stripe as never
    );

    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it("skips checkout.session.completed with mode=subscription", async () => {
    const stripe = makeStripe();
    await promoteDefaultPaymentMethod(
      {
        ...baseEvent,
        id: "evt_sub",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_sub",
            object: "checkout.session",
            mode: "subscription",
            customer: "cus_1",
            payment_intent: null,
            setup_intent: null,
          },
        },
      } as never,
      stripe as never
    );

    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
    expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(stripe.setupIntents.retrieve).not.toHaveBeenCalled();
  });

  it("skips when session has no customer", async () => {
    const stripe = makeStripe();
    await promoteDefaultPaymentMethod(
      {
        ...baseEvent,
        id: "evt_nocust",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_nocust",
            object: "checkout.session",
            mode: "payment",
            customer: null,
            payment_intent: "pi_x",
          },
        },
      } as never,
      stripe as never
    );

    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
  });
});

describe("promoteDefaultPaymentMethod — no-op when default already set", () => {
  it("does NOT call customers.update when invoice_settings.default_payment_method already populated", async () => {
    const stripe = makeStripe();
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      payment_method: "pm_new",
    });
    stripe.customers.retrieve.mockResolvedValue({
      id: "cus_1",
      object: "customer",
      deleted: false,
      invoice_settings: { default_payment_method: "pm_existing" },
      metadata: { org_id: TEST_ORG_ID },
    });

    await promoteDefaultPaymentMethod(
      {
        ...baseEvent,
        id: "evt_already",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_already",
            object: "checkout.session",
            mode: "payment",
            customer: "cus_1",
            payment_intent: "pi_1",
          },
        },
      } as never,
      stripe as never
    );

    expect(stripe.customers.retrieve).toHaveBeenCalledWith("cus_1");
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });
});

describe("promoteDefaultPaymentMethod — promotes when no default", () => {
  it("checkout.session.completed mode=payment: PM already attached, no attach call, updates customer, re-mirrors", async () => {
    const stripe = makeStripe();
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      payment_method: "pm_new",
    });
    stripe.customers.retrieve.mockResolvedValue({
      id: "cus_1",
      object: "customer",
      deleted: false,
      invoice_settings: { default_payment_method: null },
      metadata: { org_id: TEST_ORG_ID },
    });
    stripe.paymentMethods.retrieve.mockResolvedValue({
      id: "pm_new",
      customer: "cus_1",
    });
    stripe.customers.update.mockResolvedValue({
      id: "cus_1",
      object: "customer",
      email: "x@example.com",
      name: null,
      description: null,
      phone: null,
      metadata: { org_id: TEST_ORG_ID },
      livemode: false,
      created: 1700000000,
      invoice_settings: { default_payment_method: "pm_new" },
    });

    await promoteDefaultPaymentMethod(
      {
        ...baseEvent,
        id: "evt_pay",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_pay",
            object: "checkout.session",
            mode: "payment",
            customer: "cus_1",
            payment_intent: "pi_1",
          },
        },
      } as never,
      stripe as never
    );

    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledWith("pi_1");
    expect(stripe.customers.retrieve).toHaveBeenCalledWith("cus_1");
    expect(stripe.paymentMethods.retrieve).toHaveBeenCalledWith("pm_new");
    expect(stripe.paymentMethods.attach).not.toHaveBeenCalled();
    expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", {
      invoice_settings: { default_payment_method: "pm_new" },
    });
    expect(dbMock.lastInsertValues("customers")).toBeDefined();
  });

  it("checkout.session.completed mode=setup: retrieves SI, attaches if needed, updates customer", async () => {
    const stripe = makeStripe();
    stripe.setupIntents.retrieve.mockResolvedValue({
      id: "si_1",
      payment_method: "pm_setup",
    });
    stripe.customers.retrieve.mockResolvedValue({
      id: "cus_setup",
      object: "customer",
      deleted: false,
      invoice_settings: { default_payment_method: null },
      metadata: { org_id: TEST_ORG_ID },
    });
    stripe.paymentMethods.retrieve.mockResolvedValue({
      id: "pm_setup",
      customer: "cus_setup",
    });
    stripe.customers.update.mockResolvedValue({
      id: "cus_setup",
      object: "customer",
      email: null,
      name: null,
      description: null,
      phone: null,
      metadata: { org_id: TEST_ORG_ID },
      livemode: false,
      created: 1700000000,
      invoice_settings: { default_payment_method: "pm_setup" },
    });

    await promoteDefaultPaymentMethod(
      {
        ...baseEvent,
        id: "evt_setup",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_setup",
            object: "checkout.session",
            mode: "setup",
            customer: "cus_setup",
            setup_intent: "si_1",
          },
        },
      } as never,
      stripe as never
    );

    expect(stripe.setupIntents.retrieve).toHaveBeenCalledWith("si_1");
    expect(stripe.paymentMethods.attach).not.toHaveBeenCalled();
    expect(stripe.customers.update).toHaveBeenCalledWith("cus_setup", {
      invoice_settings: { default_payment_method: "pm_setup" },
    });
  });

  it("setup_intent.succeeded: reads PM from payload, updates customer", async () => {
    const stripe = makeStripe();
    stripe.customers.retrieve.mockResolvedValue({
      id: "cus_si",
      object: "customer",
      deleted: false,
      invoice_settings: { default_payment_method: null },
      metadata: { org_id: TEST_ORG_ID },
    });
    stripe.paymentMethods.retrieve.mockResolvedValue({
      id: "pm_si_direct",
      customer: "cus_si",
    });
    stripe.customers.update.mockResolvedValue({
      id: "cus_si",
      object: "customer",
      email: null,
      name: null,
      description: null,
      phone: null,
      metadata: { org_id: TEST_ORG_ID },
      livemode: false,
      created: 1700000000,
      invoice_settings: { default_payment_method: "pm_si_direct" },
    });

    await promoteDefaultPaymentMethod(
      {
        ...baseEvent,
        id: "evt_si",
        type: "setup_intent.succeeded",
        data: {
          object: {
            id: "si_direct",
            object: "setup_intent",
            customer: "cus_si",
            payment_method: "pm_si_direct",
          },
        },
      } as never,
      stripe as never
    );

    expect(stripe.setupIntents.retrieve).not.toHaveBeenCalled();
    expect(stripe.paymentMethods.attach).not.toHaveBeenCalled();
    expect(stripe.customers.update).toHaveBeenCalledWith("cus_si", {
      invoice_settings: { default_payment_method: "pm_si_direct" },
    });
  });
});

describe("promoteDefaultPaymentMethod — PM precondition handling", () => {
  it("auto-attaches PM when unattached, then sets default", async () => {
    const stripe = makeStripe();
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_unattached",
      payment_method: "pm_unattached",
    });
    stripe.customers.retrieve.mockResolvedValue({
      id: "cus_target",
      object: "customer",
      deleted: false,
      invoice_settings: { default_payment_method: null },
      metadata: { org_id: TEST_ORG_ID },
    });
    stripe.paymentMethods.retrieve.mockResolvedValue({
      id: "pm_unattached",
      customer: null,
    });
    stripe.paymentMethods.attach.mockResolvedValue({
      id: "pm_unattached",
      customer: "cus_target",
    });
    stripe.customers.update.mockResolvedValue({
      id: "cus_target",
      object: "customer",
      email: null,
      name: null,
      description: null,
      phone: null,
      metadata: { org_id: TEST_ORG_ID },
      livemode: false,
      created: 1700000000,
      invoice_settings: { default_payment_method: "pm_unattached" },
    });

    await promoteDefaultPaymentMethod(
      {
        ...baseEvent,
        id: "evt_attach",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_attach",
            object: "checkout.session",
            mode: "payment",
            customer: "cus_target",
            payment_intent: "pi_unattached",
          },
        },
      } as never,
      stripe as never
    );

    expect(stripe.paymentMethods.attach).toHaveBeenCalledWith("pm_unattached", {
      customer: "cus_target",
    });
    expect(stripe.customers.update).toHaveBeenCalledWith("cus_target", {
      invoice_settings: { default_payment_method: "pm_unattached" },
    });
  });

  it("skips + warns when PM is attached to a different customer", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stripe = makeStripe();
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_other",
      payment_method: "pm_other",
    });
    stripe.customers.retrieve.mockResolvedValue({
      id: "cus_target",
      object: "customer",
      deleted: false,
      invoice_settings: { default_payment_method: null },
      metadata: { org_id: TEST_ORG_ID },
    });
    stripe.paymentMethods.retrieve.mockResolvedValue({
      id: "pm_other",
      customer: "cus_someone_else",
    });

    await promoteDefaultPaymentMethod(
      {
        ...baseEvent,
        id: "evt_owned_elsewhere",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_owned_elsewhere",
            object: "checkout.session",
            mode: "payment",
            customer: "cus_target",
            payment_intent: "pi_other",
          },
        },
      } as never,
      stripe as never
    );

    expect(stripe.paymentMethods.attach).not.toHaveBeenCalled();
    expect(stripe.customers.update).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("attached to cus_someone_else")
    );
    warnSpy.mockRestore();
  });
});

describe("promoteDefaultPaymentMethod — skip when PM cannot be derived", () => {
  it("returns without error when PaymentIntent has no payment_method", async () => {
    const stripe = makeStripe();
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_empty",
      payment_method: null,
    });

    await promoteDefaultPaymentMethod(
      {
        ...baseEvent,
        id: "evt_nopm",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_nopm",
            object: "checkout.session",
            mode: "payment",
            customer: "cus_1",
            payment_intent: "pi_empty",
          },
        },
      } as never,
      stripe as never
    );

    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });
});

describe("promoteDefaultPaymentMethod — error propagation", () => {
  it("propagates customers.update errors so the webhook returns 5xx", async () => {
    const stripe = makeStripe();
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      payment_method: "pm_new",
    });
    stripe.customers.retrieve.mockResolvedValue({
      id: "cus_1",
      object: "customer",
      deleted: false,
      invoice_settings: { default_payment_method: null },
      metadata: { org_id: TEST_ORG_ID },
    });
    stripe.paymentMethods.retrieve.mockResolvedValue({
      id: "pm_new",
      customer: "cus_1",
    });
    stripe.customers.update.mockRejectedValue(new Error("stripe boom"));

    await expect(
      promoteDefaultPaymentMethod(
        {
          ...baseEvent,
          id: "evt_err",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_err",
              object: "checkout.session",
              mode: "payment",
              customer: "cus_1",
              payment_intent: "pi_1",
            },
          },
        } as never,
        stripe as never
      )
    ).rejects.toThrow("stripe boom");
  });
});

describe("promoteDefaultPaymentMethod — deleted customer", () => {
  it("skips when customers.retrieve returns a deleted customer", async () => {
    const stripe = makeStripe();
    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_1",
      payment_method: "pm_new",
    });
    stripe.customers.retrieve.mockResolvedValue({
      id: "cus_deleted",
      object: "customer",
      deleted: true,
    });

    await promoteDefaultPaymentMethod(
      {
        ...baseEvent,
        id: "evt_deleted",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_deleted",
            object: "checkout.session",
            mode: "payment",
            customer: "cus_deleted",
            payment_intent: "pi_1",
          },
        },
      } as never,
      stripe as never
    );

    expect(stripe.customers.update).not.toHaveBeenCalled();
  });
});
