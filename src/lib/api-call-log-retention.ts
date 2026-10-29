import { sql, type SQL } from "drizzle-orm";
import { db } from "../db";

/**
 * Retention for `api_call_log`, the request audit (BOX-DISK-FULL-1029).
 *
 * Every authenticated request appends one row (`middleware/callLog.ts`) and nothing
 * in the service reads it back: it is a debugging trail. It had no retention, so it
 * grew forever: 16.8M rows / 6.4 GB on 2026-10-29 (~400k rows a day, mostly the
 * dashboard polling payment methods), the 3rd largest table of the box the day
 * its disk filled and Postgres crash-looped. Rows older than 30 days are deleted;
 * the space they free is reused by new rows, so the table stops growing.
 *
 * The table has no index on `created_at` alone; the deletes walk the existing
 * `(org_id, created_at)` index org by org (orgs found by a loose index scan), in
 * small chunks so each statement holds its locks briefly. The ORDER BY created_at is what
 * makes the planner take that index: without it, prod picked a seq scan for the biggest
 * org (700 ms per chunk on a full table, worse as the old head of the heap empties; 32 ms
 * with it).
 */
export const API_CALL_LOG_RETENTION_DAYS = 30;

const CHUNK_SIZE = 5_000;
/** Ceiling on statements per sweep: the first sweep has ~8M rows to drop, later ones a day's worth. */
const MAX_CHUNKS_PER_SWEEP = 400;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

type Execute = (query: SQL) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
const defaultExecute: Execute = (q) => db.execute(q) as never;

export type ApiCallLogPurgeResult = { cutoff: Date; deleted: number; chunks: number; hitChunkCap: boolean };

export async function purgeExpiredApiCallLog(
  execute: Execute = defaultExecute,
  now: Date = new Date(),
  retentionDays: number = API_CALL_LOG_RETENTION_DAYS,
): Promise<ApiCallLogPurgeResult> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  // Distinct org ids (NULL included) through the (org_id, created_at) index, one probe per org.
  const orgs = await execute(sql`
    WITH RECURSIVE o AS (
      (SELECT org_id FROM api_call_log WHERE org_id IS NOT NULL ORDER BY org_id LIMIT 1)
      UNION ALL
      SELECT (SELECT org_id FROM api_call_log WHERE org_id > o.org_id ORDER BY org_id LIMIT 1) FROM o WHERE o.org_id IS NOT NULL
    )
    SELECT org_id FROM o WHERE org_id IS NOT NULL`);
  const scopes: (string | null)[] = [...orgs.rows.map((r) => r.org_id as string), null];

  let deleted = 0;
  let chunks = 0;
  for (const org of scopes) {
    const match = org === null ? sql`org_id IS NULL` : sql`org_id = ${org}`;
    for (;;) {
      if (chunks >= MAX_CHUNKS_PER_SWEEP) return { cutoff, deleted, chunks, hitChunkCap: true };
      const res = await execute(sql`
        DELETE FROM api_call_log WHERE id IN (
          SELECT id FROM api_call_log WHERE ${match} AND created_at < ${cutoff.toISOString()}::timestamp
          ORDER BY created_at LIMIT ${CHUNK_SIZE}
        )`);
      chunks++;
      const n = res.rowCount ?? 0;
      deleted += n;
      if (n < CHUNK_SIZE) break;
    }
  }
  return { cutoff, deleted, chunks, hitChunkCap: false };
}

export function startApiCallLogRetention(): void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    purgeExpiredApiCallLog()
      .then((r) =>
        console.log(
          `[stripe-service] api_call_log retention: deleted=${r.deleted} chunks=${r.chunks} cutoff=${r.cutoff.toISOString()}` +
            (r.hitChunkCap ? " (chunk cap hit, rest next sweep)" : ""),
        ),
      )
      .catch((err) => console.error("[stripe-service] api_call_log retention failed:", err))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(tick, 90_000);
  setInterval(tick, SWEEP_INTERVAL_MS);
}
