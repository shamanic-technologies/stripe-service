import type Stripe from "stripe";
import { db } from "../db";
import { eventSyncCursor, events } from "../db/schema";
import { and, asc, eq, gte, isNull, notLike, sql } from "drizzle-orm";
import { resolvePlatformKey } from "./key-client";
import { makeStripeClient } from "./stripe-client";
import { processEvent } from "./event-processor";

const POLL_INTERVAL_MS = 5 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

/**
 * Periodically pull Stripe events since the last seen cursor and process them.
 * Backup for missed webhooks. Idempotent via processEvent.
 *
 * Uses the platform Stripe key (account-wide) since events span all customers
 * on the connected Stripe account. Per-org segregation arises naturally from
 * each event's metadata.org_id stamped at create time.
 */
export function startEventPoller(): void {
  if (timer) return;
  if (process.env.RUN_EVENT_POLLER === "false") {
    console.log("[stripe-service] Event poller disabled (RUN_EVENT_POLLER=false)");
    return;
  }
  console.log(`[stripe-service] Event poller starting, interval=${POLL_INTERVAL_MS}ms`);
  timer = setInterval(pollOnce, POLL_INTERVAL_MS);
  timer.unref?.();
}

export function stopEventPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

type StripeClient = ReturnType<typeof makeStripeClient>;
type StripeEventList = Awaited<ReturnType<StripeClient["events"]["list"]>>;

/**
 * Walk Stripe's events FORWARD from the stored cursor, every page up to now.
 *
 * Stripe lists events newest-first, so `starting_after` pages to OLDER events
 * and `ending_before` to NEWER ones. The poller used `starting_after` and so
 * re-read history behind its cursor instead of what happened after it (probed
 * live 2026-11-03, STALE-CARD-AFTER-REMOVAL-1103): events only Stripe's poll
 * delivers to us (payment_method.*, setup_intent.*, invoice.*) arrived days
 * late or never. Each `ending_before` page holds the events just newer than
 * the cursor; the next page starts after its newest.
 *
 * Stripe retains events ~30 days. A cursor that aged out cannot be resolved
 * (`resource_missing` on `ending_before`) and re-using it would wedge the poller
 * forever, so on that specific error the walk restarts from the newest page;
 * the gap is covered by the boot back-fill through the object-list APIs.
 */
async function listPage(
  stripe: StripeClient,
  endingBefore: string | undefined
): Promise<{ page: StripeEventList; cursorReset: boolean }> {
  try {
    return {
      page: await stripe.events.list({ limit: 100, ending_before: endingBefore }),
      cursorReset: false,
    };
  } catch (err) {
    if (
      endingBefore !== undefined &&
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "resource_missing" &&
      (err as { param?: string }).param === "ending_before"
    ) {
      console.warn(
        `[stripe-service] Event poll cursor '${endingBefore}' aged out of Stripe retention; resetting to newest events.`
      );
      return { page: await stripe.events.list({ limit: 100 }), cursorReset: true };
    }
    throw err;
  }
}

/** Upper bound on pages per poll, so a long outage drains over several ticks. */
const MAX_PAGES_PER_POLL = 50;

async function saveCursor(newestId: string): Promise<void> {
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
}

/**
 * Process ONE event, never letting it stop the others. A throwing event stays
 * stored with its side-effects incomplete, so it is re-run by
 * `retryIncompleteEvents` on every later poll and by any redelivery; it is
 * logged loud each time. Before this, one event whose side-effect kept
 * throwing (a default-card promotion naming a detached card) aborted the whole
 * batch, so the cursor never moved again (prod 2026-10-29 → 2026-11-03).
 */
async function processIsolated(evt: Stripe.Event): Promise<{ wasNew: boolean; failed: boolean }> {
  try {
    return { wasNew: await processEvent(evt, "poll"), failed: false };
  } catch (err) {
    console.error(
      `[stripe-service] Event poll: ${evt.id} (${evt.type}) failed; left for retry, poll continues:`,
      err
    );
    return { wasNew: false, failed: true };
  }
}

/** Stored events whose side-effects threw, re-run oldest first, bounded. */
const RETRY_BATCH = 20;

export async function retryIncompleteEvents(): Promise<number> {
  const rows = await db
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(
        isNull(events.sideEffectsCompletedAt),
        notLike(events.type, "api_snapshot.%"),
        gte(events.receivedAt, sql`now() - interval '30 days'`)
      )
    )
    .orderBy(asc(events.receivedAt))
    .limit(RETRY_BATCH);
  let completed = 0;
  for (const row of rows) {
    const { wasNew } = await processIsolated(row.payload as unknown as Stripe.Event);
    if (wasNew) completed += 1;
  }
  return completed;
}

export async function pollOnce(): Promise<number> {
  try {
    const { key } = await resolvePlatformKey("stripe", {
      method: "POST",
      path: "/internal/event-poller",
    });
    const stripe = makeStripeClient(key);

    const cursor = await db
      .select()
      .from(eventSyncCursor)
      .where(eq(eventSyncCursor.id, 1))
      .limit(1);
    let endingBefore = cursor[0]?.lastEventId ?? undefined;

    let fetched = 0;
    let processed = 0;
    let failed = 0;
    for (let pageNo = 0; pageNo < MAX_PAGES_PER_POLL; pageNo += 1) {
      const { page, cursorReset } = await listPage(stripe, endingBefore);
      if (page.data.length === 0) break;
      fetched += page.data.length;

      // Newest-first within the page. Process oldest-first to preserve causal order.
      for (const evt of [...page.data].reverse()) {
        const r = await processIsolated(evt);
        if (r.wasNew) processed += 1;
        if (r.failed) failed += 1;
      }

      endingBefore = page.data[0].id;
      await saveCursor(endingBefore);
      // No cursor (first run) or a reset: the newest page is all there is to see.
      if (cursor.length === 0 || cursorReset || !page.has_more) break;
    }

    const retried = await retryIncompleteEvents();

    if (fetched > 0 || failed > 0 || retried > 0) {
      console.log(
        `[stripe-service] Event poll: fetched=${fetched}, newly_processed=${processed}, failed=${failed}, retried_completed=${retried}, cursor=${endingBefore}`
      );
    }
    return processed;
  } catch (err) {
    console.error("[stripe-service] Event poller failed:", err);
    return 0;
  }
}
