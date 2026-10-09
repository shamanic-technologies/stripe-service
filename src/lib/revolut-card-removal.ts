import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { customers } from "../db/schema";
import { reportPaymentMethodLost } from "./billing-client";
import type { PaymentMethodRemoval } from "./remove-payment-methods";
import {
  deleteCustomerPaymentMethod,
  listCustomerPaymentMethods,
  type RevolutPaymentMethod,
} from "./revolut-client";
import {
  PAYMENT_METHOD_REMOVED_EVENT_TYPE,
  sendStaffEmail,
} from "./transactional-email-client";

/**
 * Remove EVERY payment method a Revolut customer holds — the Revolut half of a
 * customer-initiated "stop holding my card".
 *
 * Revolut DOES expose a delete: `DELETE /customers/{id}/payment-methods/{pm}`
 * (confirmed live 2026-10-09). The route used to answer about Stripe only, on
 * the assumption that Revolut "exposes no detach", so an org pinned to Revolut
 * got a 200 with nothing removed while its card stayed saved — AscendQE clicked
 * Remove card twice and the card was still there each time.
 *
 * Same contract as the Stripe side: every method (never only the one in use),
 * a method the acquirer reports as already gone (404) counts as
 * `alreadyDetached`, a customer the acquirer no longer has is nothing to
 * remove, anything else propagates.
 *
 * ## Proven, not assumed
 *
 * After deleting, the customer's list is read AGAIN. Any method still there is
 * a removal that did not happen, and it throws: a silent empty success while a
 * card remains is exactly the bug this replaces.
 *
 * ## The after-state is fired HERE, because Revolut sends nothing
 *
 * On Stripe the "no chargeable card left" signal to billing-service and the
 * staff email ride the `payment_method.detached` webhook. Revolut's webhooks
 * are `ORDER_*` only — there is no payment-method event to ride. So when THIS
 * call removed at least one method and none remain, it tells billing-service
 * and emails staff itself. Keyed on `detached` (not `alreadyDetached`), so a
 * replay or a concurrent second click — which finds the method already gone —
 * does not signal twice: one removal, one signal.
 *
 * Both are swallowed and logged loud, like the webhook side-effect: the card
 * IS gone at that point, and failing the request would tell the customer "could
 * not remove" about a card that was removed (and a retry would find nothing to
 * remove, so it could not re-signal either). billing-service's own hourly scan
 * bounds what a lost signal costs.
 */
export interface RevolutCardRemoval extends PaymentMethodRemoval {
  /** Whether the "no chargeable card left" signal reached billing-service. */
  lostSignalSent: boolean;
}

export async function removeAllRevolutPaymentMethods(
  orgId: string,
  customerId: string
): Promise<RevolutCardRemoval> {
  let methods: RevolutPaymentMethod[];
  try {
    methods = await listCustomerPaymentMethods(customerId);
  } catch (err) {
    // The acquirer stating the customer is gone is an ANSWER: it holds nothing.
    if (isNotFound(err)) {
      return { detached: [], alreadyDetached: [], lostSignalSent: false };
    }
    throw err;
  }

  const detached: string[] = [];
  const alreadyDetached: string[] = [];
  const removed: RevolutPaymentMethod[] = [];

  for (const method of methods.filter((m) => m.id)) {
    try {
      await deleteCustomerPaymentMethod(customerId, method.id);
      detached.push(method.id);
      removed.push(method);
    } catch (err) {
      if (isNotFound(err)) {
        alreadyDetached.push(method.id);
        continue;
      }
      throw err;
    }
  }

  const remaining = (await listCustomerPaymentMethods(customerId)).filter(
    (m) => m.id
  );
  if (remaining.length > 0) {
    throw new Error(
      `Revolut customer ${customerId} (org ${orgId}) still holds ` +
        `${remaining.map((m) => m.id).join(", ")} after removal — the card was not removed`
    );
  }

  let lostSignalSent = false;
  if (detached.length > 0) {
    lostSignalSent = await signalPaymentMethodLost(orgId);
    await notifyStaff(orgId, customerId, removed);
  }

  return { detached, alreadyDetached, lostSignalSent };
}

async function signalPaymentMethodLost(orgId: string): Promise<boolean> {
  try {
    await reportPaymentMethodLost(orgId);
    console.log(
      `[stripe-service] billing-service told org ${orgId} has no chargeable payment method left (revolut removal)`
    );
    return true;
  } catch (err) {
    console.error(
      `[stripe-service] Telling billing-service that org ${orgId} lost its last payment method (revolut removal) failed and was swallowed — the card is already removed:`,
      err
    );
    return false;
  }
}

/**
 * Same template and event key as the Stripe detach notification, one mail per
 * removed method, with the remaining count the removal just proved (zero).
 */
async function notifyStaff(
  orgId: string,
  customerId: string,
  removed: RevolutPaymentMethod[]
): Promise<void> {
  const owner = await lookupOrgLabel(orgId);
  for (const method of removed) {
    try {
      await sendStaffEmail({
        eventType: PAYMENT_METHOD_REMOVED_EVENT_TYPE,
        orgId,
        metadata: {
          orgId,
          orgLabel: owner.name || owner.email || orgId,
          customerId,
          customerLabel: owner.name || owner.email || "no name on file",
          customerEmail: owner.email ?? "",
          paymentMethodId: method.id,
          paymentMethodLabel: describeRevolutMethod(method),
          cardsRemaining: "0",
          cardsRemainingLabel: "no chargeable card left",
          impact:
            "No chargeable card is left on this organisation, so automatic top-up will fail from now on.",
          removedAt: new Date().toISOString(),
          eventId: `revolut-removal:${method.id}`,
        },
      });
    } catch (err) {
      console.error(
        `[stripe-service] Staff notification for the Revolut removal of ${method.id} (org ${orgId}) failed and was swallowed — the card is already removed:`,
        err
      );
    }
  }
}

async function lookupOrgLabel(
  orgId: string
): Promise<{ name: string | null; email: string | null }> {
  try {
    const rows = await db
      .select({ name: customers.name, email: customers.email })
      .from(customers)
      .where(eq(customers.orgId, orgId))
      .orderBy(desc(customers.syncedAt))
      .limit(1);
    return { name: rows[0]?.name ?? null, email: rows[0]?.email ?? null };
  } catch (err) {
    console.error(
      `[stripe-service] Could not read a label for org ${orgId} for the Revolut removal email:`,
      err
    );
    return { name: null, email: null };
  }
}

/** "Mastercard ending 6003, expires 04/2033" from Revolut's flat fields. */
export function describeRevolutMethod(method: RevolutPaymentMethod): string {
  const m = method as RevolutPaymentMethod & {
    brand?: string;
    last_four?: string;
    expiry_month?: number;
    expiry_year?: number;
  };
  const kind = humanise(m.brand ?? m.type ?? "card");
  if (!m.last_four) return kind;
  const expiry =
    m.expiry_month && m.expiry_year
      ? `, expires ${String(m.expiry_month).padStart(2, "0")}/${m.expiry_year}`
      : "";
  return `${kind} ending ${m.last_four}${expiry}`;
}

function humanise(value: string): string {
  return value
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Read by NAME, not `instanceof`: the client module is mocked in tests. */
function isNotFound(err: unknown): boolean {
  const e = err as { name?: unknown; status?: unknown } | null;
  return e?.name === "RevolutApiError" && e.status === 404;
}
