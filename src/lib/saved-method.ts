import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { customers } from "../db/schema";
import { resolveAcquirer, type Acquirer, type AcquirerPin } from "./acquirer";
import {
  NoChargeablePaymentMethod,
  resolveStripeChargeablePaymentMethod,
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
    // Throws if the acquirer cannot be reached. That is the point.
    const methods = await listCustomerPaymentMethods(pin.customerId);
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
    const id = await resolveStripeChargeablePaymentMethod(stripe, orgId, row[0].id);
    return {
      object: "saved_payment_method",
      acquirer: pin.acquirer,
      saved: true,
      method: { id, type: "card", saved_for: null },
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
