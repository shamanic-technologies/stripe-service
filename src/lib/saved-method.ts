import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { customers } from "../db/schema";
import { resolveAcquirer, type Acquirer, type AcquirerPin } from "./acquirer";
import {
  NoChargeablePaymentMethod,
  resolveStripeChargeablePaymentMethodObject,
} from "./charge-org";
import { getPlatformStripe } from "./event-processor";
import { listCustomerPaymentMethods } from "./revolut-client";

/**
 * "Is there a card saved for this org that we can charge later, with nobody
 * present?" — asked of whichever acquirer actually holds the org's cards, and
 * answered with the three outcomes kept APART.
 *
 * The three answers are the whole point of this file. A card was requested, the
 * request was accepted, nothing was stored, and nothing anywhere said so: that
 * is the failure this exists to make impossible to repeat. So:
 *
 *   - a card IS saved         -> `{ saved: true, method }`
 *   - no card is saved        -> `{ saved: false, reason }`
 *   - we could not ASK        -> THROWS
 *
 * The third is never folded into the second. "The acquirer says there is no
 * card" and "the acquirer did not answer" are different facts, and only the
 * first one is safe to act on: arming automatic top-ups off a timeout would arm
 * them for an org that cannot be charged, which is exactly the state that stops
 * a customer's campaigns with nothing reporting why. Same rule the pin guard
 * already follows — an acquirer we cannot reach propagates.
 *
 * Read LIVE, never cached. A method can be detached, replaced or made
 * ineligible for merchant-initiated use at the acquirer without an event we
 * would ever see, so a stored "yes" drifts into a lie.
 */

/** The saved method itself, in the only terms both acquirers can express. */
export interface SavedMethodRef {
  /** The acquirer's id for the method — what a later charge names. */
  id: string;
  /** `card`, `link`, … Whatever the acquirer calls it, verbatim. */
  type: string;
  /**
   * Who the method was saved FOR, when the acquirer states it. Merchant-
   * initiated is the one that matters: a method saved only for the CUSTOMER's
   * own checkouts cannot be charged with nobody on the page.
   *
   * `null` when the acquirer does not report it (Stripe does not — a card
   * attached to a customer is chargeable off-session by id).
   */
  saved_for: string | null;
  /**
   * How the card is funded, as the acquirer states it, lowercased verbatim:
   * `credit`, `debit`, `prepaid`, … `null` when the acquirer does not state it
   * (Stripe's own `"unknown"`, a Link method with no card, a field absent).
   */
  funding: string | null;
  /**
   * Is this a PREPAID card? Three answers kept apart, like the rest of this
   * file: `true` the acquirer says prepaid; `false` the acquirer states a
   * funding that is not prepaid; `null` the acquirer does not say. `null` is
   * NEVER "not prepaid".
   */
  prepaid: boolean | null;
  /**
   * The country the card was ISSUED in, ISO 3166-1 alpha-2 uppercase, as the
   * acquirer states it: Stripe `card.country`, Revolut `issuer_country` (observed
   * live 2026-10-13: `"US"`). For a Stripe LINK method — which carries no card —
   * it is the country of the funding source beneath the Link payment, read off
   * that method's latest settled charge (`payment_method_details.link.country`);
   * Link never states that source's funding, so `funding`/`prepaid` stay `null`.
   * `null` when the acquirer does not state it (a Link method never charged yet).
   */
  country: string | null;
}

/** Normalise an acquirer's country statement to ISO alpha-2 uppercase, or null. */
export function countryFact(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const country = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : null;
}

/**
 * The funding-source country beneath a Stripe Link method, from the latest
 * settled charge that used it. Read from bronze (every `charge.succeeded` is
 * stored there), so it costs no Stripe call. Link hides the card, so this is the
 * only place its country is ever stated.
 */
async function linkFundingCountry(paymentMethodId: string): Promise<string | null> {
  const rows = await db.execute<{ country: string | null }>(sql`
    SELECT payload->'data'->'object'->'payment_method_details'->'link'->>'country' AS country
    FROM events
    WHERE type = 'charge.succeeded'
      AND payload->'data'->'object'->>'payment_method' = ${paymentMethodId}
    ORDER BY created_stripe DESC NULLS LAST, received_at DESC
    LIMIT 1
  `);
  return countryFact(rows.rows[0]?.country);
}

/**
 * Normalise an acquirer's funding statement. Stripe states `card.funding`
 * (`credit` | `debit` | `prepaid` | `unknown`); Revolut states `funding` on the
 * saved method itself (observed live 2026-10-12: `"prepaid"` on a US Visa).
 * Stripe's `"unknown"` is the acquirer NOT stating it, so it reads as `null`.
 */
export function fundingFacts(raw: unknown): Pick<SavedMethodRef, "funding" | "prepaid"> {
  if (typeof raw !== "string") return { funding: null, prepaid: null };
  const funding = raw.trim().toLowerCase();
  if (funding === "" || funding === "unknown") return { funding: null, prepaid: null };
  return { funding, prepaid: funding === "prepaid" };
}

/**
 * The acquirer told us, definitively, that this customer is not there.
 *
 * That is the SECOND of the three answers, not the third: the acquirer was
 * reachable, it answered, and its answer was that the customer does not exist —
 * so it holds no card for the org and there is nothing that could be stranded.
 * Reading it as "we could not ask" makes such an org permanently unmovable: the
 * guard it must pass to be pinned anywhere can never come back clean, so it can
 * never be pinned anywhere. Observed in production 2026-09-08 on an org whose
 * mirrored `cus_…` no longer exists at Stripe — its pin returned a 400 carrying
 * `No such customer`.
 *
 * ⚠️ This does NOT weaken the never-fail-soft rule. A timeout, a network error,
 * a 5xx, an auth failure — anything that is not the acquirer stating the
 * customer's absence — still propagates and still refuses the move. Only this
 * one specific, definitive answer is reclassified.
 *
 * Stripe states it as `resource_missing`; the only resource named on the call
 * this wraps (`paymentMethods.list({ customer })`) is the customer itself.
 * Revolut states it as a 404 on the customer's own payment-methods collection.
 */
function acquirerSaysCustomerIsGone(err: unknown): boolean {
  const e = err as { name?: unknown; status?: unknown; code?: unknown } | null;
  // Read by NAME rather than by `instanceof`: the error crosses a module the
  // tests mock, and an identity check there answers false for the very error
  // it is meant to recognise.
  if (e?.name === "RevolutApiError") return e.status === 404;
  return e?.code === "resource_missing";
}

/** Why there is no saved method. Never used to describe a failure to ask. */
export type NotSavedReason =
  /** The org has no customer at the acquirer, so nothing could be saved. */
  | "no_customer"
  /** The acquirer answered, and holds no method at all. */
  | "no_saved_method"
  /**
   * The acquirer holds a method, but saved for the CUSTOMER's own future
   * checkouts — it cannot be charged merchant-initiated, which is the only
   * kind of charge automatic top-up makes.
   */
  | "not_saved_for_merchant";

export type SavedMethodConfirmation =
  | {
      object: "saved_payment_method";
      acquirer: Acquirer;
      saved: true;
      method: SavedMethodRef;
    }
  | {
      object: "saved_payment_method";
      acquirer: Acquirer;
      saved: false;
      method: null;
      reason: NotSavedReason;
    };

/**
 * A Revolut method is usable for automatic top-up unless the acquirer says it
 * was saved for the customer's own checkouts.
 *
 * ⚠️ UNVERIFIED against a real saved card: no card has ever been saved on this
 * acquirer (the field that asks for it was being sent on an order that belonged
 * to nobody), so the exact string in `saved_for` has never been observed. The
 * predicate is therefore written to reject only what is explicitly the wrong
 * kind, rather than to require a spelling we are guessing at — a required guess
 * would refuse every real card forever, which fails the feature rather than
 * protecting it. Once a live card is saved, read the value and tighten this to
 * an equality check.
 */
function usableForMerchant(saved_for: unknown): boolean {
  return saved_for !== "customer";
}

export async function confirmSavedPaymentMethod(
  orgId: string,
  pinned?: AcquirerPin
): Promise<SavedMethodConfirmation> {
  const pin = pinned ?? (await resolveAcquirer(orgId));

  if (pin.acquirer === "revolut") {
    if (!pin.customerId) {
      return {
        object: "saved_payment_method",
        acquirer: pin.acquirer,
        saved: false,
        method: null,
        reason: "no_customer",
      };
    }
    // Throws if the acquirer cannot be reached. That is the point — except for
    // the acquirer telling us the customer is gone, which is an ANSWER.
    let methods;
    try {
      methods = await listCustomerPaymentMethods(pin.customerId);
    } catch (err) {
      if (acquirerSaysCustomerIsGone(err)) {
        return {
          object: "saved_payment_method",
          acquirer: pin.acquirer,
          saved: false,
          method: null,
          reason: "no_customer",
        };
      }
      throw err;
    }
    const withId = methods.filter((m) => m.id);
    const usable = withId.find((m) => usableForMerchant(m.saved_for));
    if (!usable) {
      return {
        object: "saved_payment_method",
        acquirer: pin.acquirer,
        saved: false,
        method: null,
        reason:
          withId.length > 0 ? "not_saved_for_merchant" : "no_saved_method",
      };
    }
    return {
      object: "saved_payment_method",
      acquirer: pin.acquirer,
      saved: true,
      method: {
        id: usable.id,
        type: usable.type ?? "card",
        saved_for: typeof usable.saved_for === "string" ? usable.saved_for : null,
        ...fundingFacts(usable.funding),
        country: countryFact(usable.issuer_country),
      },
    };
  }

  const row = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.orgId, orgId))
    .orderBy(desc(customers.syncedAt))
    .limit(1);
  if (row.length === 0) {
    return {
      object: "saved_payment_method",
      acquirer: pin.acquirer,
      saved: false,
      method: null,
      reason: "no_customer",
    };
  }

  const stripe = await getPlatformStripe();
  try {
    // The same resolution the neutral charge performs, so what this promises is
    // byte-identical to what the charge will actually name.
    const pm = await resolveStripeChargeablePaymentMethodObject(stripe, orgId, row[0].id);
    const country = pm.card
      ? countryFact(pm.card.country)
      : pm.type === "link"
        ? await linkFundingCountry(pm.id)
        : null;
    return {
      object: "saved_payment_method",
      acquirer: pin.acquirer,
      saved: true,
      method: {
        id: pm.id,
        // Verbatim: a Link method is `link`, not a card — say so.
        type: pm.type ?? "card",
        saved_for: null,
        // A Link method carries no `card`, so its funding is not stated.
        ...fundingFacts(pm.card?.funding),
        country,
      },
    };
  } catch (err) {
    if (err instanceof NoChargeablePaymentMethod) {
      return {
        object: "saved_payment_method",
        acquirer: pin.acquirer,
        saved: false,
        method: null,
        reason: "no_saved_method",
      };
    }
    // The mirror names a customer the acquirer no longer has. It answered, and
    // its answer is that there is no card here to lose. The mirror row STAYS —
    // it is what historical payments made against that customer resolve
    // through, and deleting it to make this read work would drop that money
    // from every surface that reads it.
    if (acquirerSaysCustomerIsGone(err)) {
      return {
        object: "saved_payment_method",
        acquirer: pin.acquirer,
        saved: false,
        method: null,
        reason: "no_customer",
      };
    }
    // Anything else is "we could not ask" — propagate.
    throw err;
  }
}

/**
 * Raised when recurring charges are asked for against an org that has no card
 * saved. Carries WHY, because "no customer" and "a card exists but only for the
 * customer's own checkouts" need different things done about them.
 */
export class NoSavedPaymentMethod extends Error {
  constructor(
    readonly orgId: string,
    readonly acquirer: Acquirer,
    readonly reason: NotSavedReason
  ) {
    super(
      `Org ${orgId} has no saved payment method on ${acquirer} (${reason}), ` +
        "so recurring charges cannot be armed for it"
    );
    this.name = "NoSavedPaymentMethod";
  }
}

declare const authorizationBrand: unique symbol;

/**
 * Permission to arm recurring charges for an org.
 *
 * It is a BRANDED type on purpose: no caller can construct one, and the only
 * function that returns one is `authorizeRecurringCharges` below, which cannot
 * reach its return statement without a confirmation that came back `saved:
 * true`. So "recurring charges were armed without anyone having checked" is not
 * a mistake a caller can make here — there is no value to hand over that did
 * not come from the check.
 */
export interface RecurringChargeAuthorization {
  readonly [authorizationBrand]: "recurring-charge-authorization";
  readonly orgId: string;
  readonly acquirer: Acquirer;
  readonly method: SavedMethodRef;
}

/**
 * Confirm a saved card and, only then, mint the authorization.
 *
 * Three outcomes, matching the three answers above and keeping them apart:
 *   - saved      -> an authorization
 *   - not saved  -> `NoSavedPaymentMethod` (a refusal, with a reason)
 *   - unreachable-> whatever the acquirer threw (an error, NOT a refusal)
 */
export async function authorizeRecurringCharges(
  orgId: string
): Promise<RecurringChargeAuthorization> {
  const confirmation = await confirmSavedPaymentMethod(orgId);
  if (!confirmation.saved) {
    throw new NoSavedPaymentMethod(
      orgId,
      confirmation.acquirer,
      confirmation.reason
    );
  }
  return {
    orgId,
    acquirer: confirmation.acquirer,
    method: confirmation.method,
  } as RecurringChargeAuthorization;
}
