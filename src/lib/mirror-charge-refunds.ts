import type Stripe from "stripe";
import { recordApiSnapshot } from "./event-processor";

/**
 * Charge-level events that mean money went back out. Their `data.object` is a
 * Charge, not a Refund, so the projection cannot mirror them on its own — the
 * Refund objects have to be read off Stripe and snapshotted.
 */
const CHARGE_REFUND_EVENT_TYPES: ReadonlySet<string> = new Set([
  "charge.refunded",
  "charge.refund.updated",
]);

export function isChargeRefundEvent(eventType: string): boolean {
  return CHARGE_REFUND_EVENT_TYPES.has(eventType);
}

/**
 * Mirror every Refund attached to the Charge an event refers to.
 *
 * Why this exists on top of the projection: which event carries a refund is
 * Stripe's choice, not ours. `charge.refunded` carries a Charge; the Refund
 * only ever appears inside it as a sub-list that recent API versions no longer
 * expand (`charge.refunds` is `null` on our live payloads). So a refund that
 * announces itself only through `charge.refunded` would reach bronze and never
 * reach the refunds mirror.
 *
 * Reading the refunds off the Charge closes that: whichever of the two
 * subscribed events lands first mirrors the Refund, and the second one is an
 * idempotent re-projection of the same object. Neither is load-bearing alone.
 *
 * `refunds.list({ charge })` is keyed on the Charge, so the rail is irrelevant:
 * a `py_…` Link charge returns its `pyr_…` refunds exactly like a `ch_…` card
 * charge returns its `re_…` ones.
 *
 * Errors propagate — the webhook returns 5xx and Stripe retries, same contract
 * as every other side-effect here.
 */
export async function mirrorRefundsForChargeEvent(
  event: Stripe.Event,
  stripe: Stripe
): Promise<number> {
  const chargeId = resolveChargeId(event);
  if (!chargeId) return 0;

  let mirrored = 0;
  for await (const refund of stripe.refunds.list({
    charge: chargeId,
    limit: 100,
  })) {
    // Refund silver is org-less — the tenant is joined through the PaymentIntent.
    await recordApiSnapshot(refund, "refund", null);
    mirrored += 1;
  }
  return mirrored;
}

/**
 * The Charge an event's payload points at. `charge.refunded` IS the Charge;
 * `charge.refund.updated` carries a Refund that references one.
 */
function resolveChargeId(event: Stripe.Event): string | null {
  const obj = event.data?.object as
    | { object?: unknown; id?: unknown; charge?: unknown }
    | undefined;
  if (!obj) return null;
  if (obj.object === "charge" && typeof obj.id === "string") return obj.id;
  if (typeof obj.charge === "string") return obj.charge;
  if (
    obj.charge &&
    typeof (obj.charge as { id?: unknown }).id === "string"
  ) {
    return (obj.charge as { id: string }).id;
  }
  return null;
}
