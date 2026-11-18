import type Stripe from "stripe";
import { invalidatePaymentMethodReads } from "./payment-method-read";

/**
 * No saved payment method keeps a STAFF email in its billing details
 * (BILLING-LINK-PAYMENT-METHOD-1118).
 *
 * Why: `payer-email.ts` makes the Stripe CUSTOMER carry the payer's identity,
 * but a saved payment method keeps the email Checkout prefilled at the moment
 * it was saved. Staff opening a client's checkout first left, in prod, the
 * client's Link method `pm_1UcrYqEnlXMXdaZamoQpJyKS` with
 * `billing_details.email = kevin.lourd@gmail.com` beside the client's own name,
 * so that card's Stripe records read as staff's.
 *
 * Rule: a method on a customer whose own email is NOT staff, whose
 * `billing_details.email` IS staff, takes the customer's email (the payer, per
 * payer-email.ts). Name and address are left alone. A customer whose own email
 * is staff (our own / test orgs) is left alone, and so is a method carrying any
 * non-staff email (the client typed it).
 *
 * Fail loud: a Stripe failure propagates (webhook → retry, script → exit 1).
 */

/**
 * Staff, mirrored from billing-service `src/lib/payment-alerts.ts` `isStaffEmail`
 * (itself from api-service `src/lib/staff.ts` STAFF_EMAILS) and client-service
 * `src/lib/owner-telegram.ts`: the owner's addresses + his test address, any
 * `@distribute.you` address, plus-addressing ignored. Keep the three in step.
 */
const STAFF_EMAILS = new Set(["kevin.lourd@gmail.com", "kevin@distribute.you", "kevin@pressbeat.io"]);
const STAFF_DOMAIN = "@distribute.you";

export function isStaffEmail(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.endsWith(STAFF_DOMAIN)) return true;
  const [local, domain] = normalized.split("@");
  if (!domain) return false;
  return STAFF_EMAILS.has(`${local.split("+")[0]}@${domain}`);
}

/**
 * The email a method's billing details should take, or null to leave it.
 * Pure: the whole rule, tested on its own.
 */
export function billingEmailFix(
  pmEmail: string | null | undefined,
  customerEmail: string | null | undefined
): string | null {
  if (!customerEmail || isStaffEmail(customerEmail)) return null;
  if (!isStaffEmail(pmEmail)) return null;
  return customerEmail;
}

/** The method types a customer saves here (balance read + Checkout). */
export const ALIGNED_PM_TYPES = ["card", "link"] as const;

export interface PmEmailChange {
  paymentMethodId: string;
  customerId: string;
  type: string;
  from: string;
  to: string;
}

async function listAll(
  stripe: Stripe,
  customer: string,
  type: (typeof ALIGNED_PM_TYPES)[number]
): Promise<Stripe.PaymentMethod[]> {
  const out: Stripe.PaymentMethod[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.paymentMethods.list({
      customer,
      type,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    out.push(...page.data);
    if (!page.has_more || page.data.length === 0) return out;
    startingAfter = page.data[page.data.length - 1].id;
  }
}

/**
 * Apply the rule to every card and Link method attached to `customerId`.
 * `apply: false` only reports. Returns the changes made (or that would be).
 * After a write the remembered + stored payment-method reads are dropped (they
 * carry the methods' billing details); Stripe's `payment_method.updated`
 * webhook then stores the fresh answer.
 */
export async function alignPaymentMethodEmails(
  stripe: Stripe,
  customerId: string,
  opts: { apply?: boolean } = {}
): Promise<PmEmailChange[]> {
  const apply = opts.apply ?? true;
  const customer = await stripe.customers.retrieve(customerId);
  if ((customer as Stripe.DeletedCustomer).deleted === true) return [];
  const customerEmail = (customer as Stripe.Customer).email ?? null;
  if (!customerEmail || isStaffEmail(customerEmail)) return [];

  const changes: PmEmailChange[] = [];
  for (const type of ALIGNED_PM_TYPES) {
    for (const pm of await listAll(stripe, customerId, type)) {
      const from = pm.billing_details?.email ?? null;
      const to = billingEmailFix(from, customerEmail);
      if (!to || !from) continue;
      if (apply) {
        await stripe.paymentMethods.update(pm.id, { billing_details: { email: to } });
      }
      changes.push({ paymentMethodId: pm.id, customerId, type: pm.type, from, to });
    }
  }

  if (apply && changes.length > 0) {
    await invalidatePaymentMethodReads(customerId);
    console.log(
      `[stripe-service] ${customerId}: ${changes.length} saved method(s) no longer carry a staff email (${changes
        .map((c) => c.paymentMethodId)
        .join(", ")})`
    );
  }
  return changes;
}
