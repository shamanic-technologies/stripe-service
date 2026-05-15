import type Stripe from "stripe";
import { db } from "../db";
import {
  events,
  customers,
  checkoutSessions,
  paymentIntents,
  customerBalanceTransactions,
} from "../db/schema";
import { eq, sql } from "drizzle-orm";

type ProcessSource = "webhook" | "poll";

/**
 * Insert event idempotently and upsert the referenced object table.
 * Returns true if the event was processed (newly inserted), false if it was already known.
 */
export async function processEvent(
  event: Stripe.Event,
  source: ProcessSource
): Promise<boolean> {
  const objectId = extractObjectId(event);

  const inserted = await db
    .insert(events)
    .values({
      id: event.id,
      type: event.type,
      apiVersion: event.api_version ?? null,
      livemode: event.livemode ? "true" : "false",
      createdStripe: event.created,
      objectId,
      payload: event as unknown as Record<string, unknown>,
      source,
    })
    .onConflictDoNothing()
    .returning({ id: events.id });

  if (inserted.length === 0) {
    return false;
  }

  await upsertObjectFromEvent(event);
  return true;
}

function extractObjectId(event: Stripe.Event): string | null {
  const obj = event.data?.object as { id?: unknown } | undefined;
  if (obj && typeof obj.id === "string") return obj.id;
  return null;
}

async function upsertObjectFromEvent(event: Stripe.Event): Promise<void> {
  const obj = event.data?.object;
  if (!obj || typeof obj !== "object") return;

  if (event.type.startsWith("customer.")) {
    const customer = obj as Stripe.Customer;
    const orgId = extractOrgId(customer.metadata) ?? "unknown";
    if (event.type === "customer.deleted") {
      await db
        .delete(customers)
        .where(sql`${customers.id} = ${customer.id}`);
      return;
    }
    await upsertCustomer(customer, orgId);
    return;
  }

  if (event.type.startsWith("checkout.session.")) {
    const session = obj as Stripe.Checkout.Session;
    const orgId = extractOrgId(session.metadata) ?? "unknown";
    await upsertCheckoutSession(session, orgId);
    return;
  }

  if (event.type.startsWith("payment_intent.")) {
    const pi = obj as Stripe.PaymentIntent;
    const orgId = extractOrgId(pi.metadata) ?? "unknown";
    await upsertPaymentIntent(pi, orgId);
    return;
  }

  if (event.type.startsWith("customer_balance_transaction.")) {
    const cbt = obj as unknown as Stripe.CustomerBalanceTransaction;
    const customerId = extractString(cbt.customer);
    const orgId = customerId
      ? (await lookupOrgIdForCustomer(customerId)) ?? "unknown"
      : "unknown";
    await upsertCustomerBalanceTransaction(cbt, orgId);
    return;
  }
}

async function lookupOrgIdForCustomer(customerId: string): Promise<string | null> {
  const rows = await db
    .select({ orgId: customers.orgId })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return rows[0]?.orgId ?? null;
}

function extractOrgId(metadata: Stripe.Metadata | null | undefined): string | null {
  if (!metadata) return null;
  const v = metadata.org_id ?? metadata.orgId;
  return typeof v === "string" ? v : null;
}

export async function upsertCustomer(customer: Stripe.Customer, orgId: string): Promise<void> {
  await db
    .insert(customers)
    .values({
      id: customer.id,
      orgId,
      email: customer.email ?? null,
      name: customer.name ?? null,
      description: customer.description ?? null,
      phone: customer.phone ?? null,
      metadata: (customer.metadata ?? null) as unknown as Record<string, unknown> | null,
      livemode: customer.livemode ? "true" : "false",
      createdStripe: customer.created,
      rawJson: customer as unknown as Record<string, unknown>,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: customers.id,
      set: {
        orgId: sql`EXCLUDED.org_id`,
        email: sql`EXCLUDED.email`,
        name: sql`EXCLUDED.name`,
        description: sql`EXCLUDED.description`,
        phone: sql`EXCLUDED.phone`,
        metadata: sql`EXCLUDED.metadata`,
        livemode: sql`EXCLUDED.livemode`,
        createdStripe: sql`EXCLUDED.created_stripe`,
        rawJson: sql`EXCLUDED.raw_json`,
        syncedAt: sql`now()`,
      },
    });
}

export async function upsertCheckoutSession(
  session: Stripe.Checkout.Session,
  orgId: string
): Promise<void> {
  await db
    .insert(checkoutSessions)
    .values({
      id: session.id,
      orgId,
      customer: extractString(session.customer),
      paymentIntent: extractString(session.payment_intent),
      mode: session.mode,
      status: session.status ?? null,
      paymentStatus: session.payment_status ?? null,
      amountTotal: session.amount_total ?? null,
      currency: session.currency ?? null,
      url: session.url ?? null,
      successUrl: session.success_url ?? null,
      cancelUrl: session.cancel_url ?? null,
      metadata: (session.metadata ?? null) as unknown as Record<string, unknown> | null,
      livemode: session.livemode ? "true" : "false",
      createdStripe: session.created,
      rawJson: session as unknown as Record<string, unknown>,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: checkoutSessions.id,
      set: {
        orgId: sql`EXCLUDED.org_id`,
        customer: sql`EXCLUDED.customer`,
        paymentIntent: sql`EXCLUDED.payment_intent`,
        mode: sql`EXCLUDED.mode`,
        status: sql`EXCLUDED.status`,
        paymentStatus: sql`EXCLUDED.payment_status`,
        amountTotal: sql`EXCLUDED.amount_total`,
        currency: sql`EXCLUDED.currency`,
        url: sql`EXCLUDED.url`,
        successUrl: sql`EXCLUDED.success_url`,
        cancelUrl: sql`EXCLUDED.cancel_url`,
        metadata: sql`EXCLUDED.metadata`,
        livemode: sql`EXCLUDED.livemode`,
        createdStripe: sql`EXCLUDED.created_stripe`,
        rawJson: sql`EXCLUDED.raw_json`,
        syncedAt: sql`now()`,
      },
    });
}

export async function upsertPaymentIntent(
  pi: Stripe.PaymentIntent,
  orgId: string
): Promise<void> {
  await db
    .insert(paymentIntents)
    .values({
      id: pi.id,
      orgId,
      customer: extractString(pi.customer),
      amount: pi.amount,
      amountReceived: pi.amount_received ?? null,
      currency: pi.currency,
      status: pi.status,
      description: pi.description ?? null,
      paymentMethod: extractString(pi.payment_method),
      latestCharge: extractString(pi.latest_charge),
      clientSecret: pi.client_secret ?? null,
      metadata: (pi.metadata ?? null) as unknown as Record<string, unknown> | null,
      lastPaymentError: (pi.last_payment_error ?? null) as unknown as
        | Record<string, unknown>
        | null,
      livemode: pi.livemode ? "true" : "false",
      createdStripe: pi.created,
      rawJson: pi as unknown as Record<string, unknown>,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: paymentIntents.id,
      set: {
        orgId: sql`EXCLUDED.org_id`,
        customer: sql`EXCLUDED.customer`,
        amount: sql`EXCLUDED.amount`,
        amountReceived: sql`EXCLUDED.amount_received`,
        currency: sql`EXCLUDED.currency`,
        status: sql`EXCLUDED.status`,
        description: sql`EXCLUDED.description`,
        paymentMethod: sql`EXCLUDED.payment_method`,
        latestCharge: sql`EXCLUDED.latest_charge`,
        clientSecret: sql`EXCLUDED.client_secret`,
        metadata: sql`EXCLUDED.metadata`,
        lastPaymentError: sql`EXCLUDED.last_payment_error`,
        livemode: sql`EXCLUDED.livemode`,
        createdStripe: sql`EXCLUDED.created_stripe`,
        rawJson: sql`EXCLUDED.raw_json`,
        syncedAt: sql`now()`,
      },
    });
}

export async function upsertCustomerBalanceTransaction(
  cbt: Stripe.CustomerBalanceTransaction,
  orgId: string
): Promise<void> {
  const customerId = extractString(cbt.customer);
  if (!customerId) {
    throw new Error(
      `[stripe-service] customer_balance_transaction ${cbt.id} has no customer reference`
    );
  }
  await db
    .insert(customerBalanceTransactions)
    .values({
      id: cbt.id,
      orgId,
      customer: customerId,
      amount: cbt.amount,
      currency: cbt.currency,
      type: cbt.type,
      creditNote: extractString(cbt.credit_note),
      invoice: extractString(cbt.invoice),
      description: cbt.description ?? null,
      metadata: (cbt.metadata ?? null) as unknown as Record<string, unknown> | null,
      livemode: cbt.livemode ? "true" : "false",
      createdStripe: cbt.created,
      rawJson: cbt as unknown as Record<string, unknown>,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: customerBalanceTransactions.id,
      set: {
        orgId: sql`EXCLUDED.org_id`,
        customer: sql`EXCLUDED.customer`,
        amount: sql`EXCLUDED.amount`,
        currency: sql`EXCLUDED.currency`,
        type: sql`EXCLUDED.type`,
        creditNote: sql`EXCLUDED.credit_note`,
        invoice: sql`EXCLUDED.invoice`,
        description: sql`EXCLUDED.description`,
        metadata: sql`EXCLUDED.metadata`,
        livemode: sql`EXCLUDED.livemode`,
        createdStripe: sql`EXCLUDED.created_stripe`,
        rawJson: sql`EXCLUDED.raw_json`,
        syncedAt: sql`now()`,
      },
    });
}

function extractString(v: string | { id?: string } | null | undefined): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  return v.id ?? null;
}
