import { db } from "../db";
import { eventSyncCursor } from "../db/schema";
import { eq, sql } from "drizzle-orm";
import { resolveStripeKey } from "./resolve-stripe-key";
import { makeStripeClient } from "./stripe-client";
import { processEvent } from "./event-processor";

const POLL_INTERVAL_MS = 5 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

/**
 * Periodically pull Stripe events since the last seen cursor and process them.
 * Backup for missed webhooks. Idempotent via processEvent.
 *
 * Uses the platform Stripe key (system identity) since events span all orgs
 * on the connected Stripe account. Per-org segregation arises naturally from
 * each event's metadata.org_id.
 */
export function startEventPoller(): void {
  if (timer) return;
  if (process.env.RUN_EVENT_POLLER === "false") {
    console.log("[stripe-service] Event poller disabled (RUN_EVENT_POLLER=false)");
    return;
  }
  console.log(`[stripe-service] Event poller starting, interval=${POLL_INTERVAL_MS}ms`);
  timer = setInterval(pollOnce, POLL_INTERVAL_MS);
  // Don't keep the process alive solely for the poller (Railway / tests)
  timer.unref?.();
}

export function stopEventPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function pollOnce(): Promise<number> {
  try {
    const orgId = process.env.PLATFORM_ORG_ID;
    const userId = process.env.PLATFORM_USER_ID;
    if (!orgId || !userId) {
      console.error(
        "[stripe-service] Event poller misconfigured: PLATFORM_ORG_ID / PLATFORM_USER_ID required"
      );
      return 0;
    }

    const { key } = await resolveStripeKey(orgId, userId, {
      method: "POST",
      path: "/internal/event-poller",
    });
    const stripe = makeStripeClient(key);

    const cursor = await db
      .select()
      .from(eventSyncCursor)
      .where(eq(eventSyncCursor.id, 1))
      .limit(1);
    const startingAfter = cursor[0]?.lastEventId ?? undefined;

    const events = await stripe.events.list({
      limit: 100,
      starting_after: startingAfter,
    });

    if (events.data.length === 0) {
      return 0;
    }

    let processed = 0;
    // Stripe returns events newest-first. Process oldest-first to preserve causal order.
    for (const evt of [...events.data].reverse()) {
      const wasNew = await processEvent(evt, "poll");
      if (wasNew) processed += 1;
    }

    // Cursor must be the newest event we've seen (events.data[0]).
    const newestId = events.data[0].id;
    await db
      .insert(eventSyncCursor)
      .values({ id: 1, lastEventId: newestId, lastSyncedAt: new Date() })
      .onConflictDoUpdate({
        target: eventSyncCursor.id,
        set: {
          lastEventId: sql`EXCLUDED.last_event_id`,
          lastSyncedAt: sql`now()`,
        },
      });

    console.log(
      `[stripe-service] Event poll: fetched=${events.data.length}, newly_processed=${processed}, cursor=${newestId}`
    );
    return processed;
  } catch (err) {
    console.error("[stripe-service] Event poller failed:", err);
    return 0;
  }
}
