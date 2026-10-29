import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

vi.mock("../../src/db", () => ({ db: {}, pool: {} }));

import { purgeExpiredApiCallLog, API_CALL_LOG_RETENTION_DAYS } from "../../src/lib/api-call-log-retention";

const dialect = new PgDialect();
const text = (q: SQL) => dialect.sqlToQuery(q);

describe("purgeExpiredApiCallLog (BOX-DISK-FULL-1029)", () => {
  it("walks every org then the org-less rows, chunk by chunk, older than 30 days only", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const deletes = [5000, 12, 0, 3];
    const execute = vi.fn(async (q: SQL) => {
      const { sql, params } = text(q);
      calls.push({ sql, params });
      if (sql.includes("WITH RECURSIVE")) return { rows: [{ org_id: "org-a" }, { org_id: "org-b" }], rowCount: 2 };
      return { rows: [], rowCount: deletes.shift() ?? 0 };
    });
    const now = new Date("2026-10-29T12:00:00Z");
    const r = await purgeExpiredApiCallLog(execute, now);
    expect(API_CALL_LOG_RETENTION_DAYS).toBe(30);
    expect(r.cutoff.toISOString()).toBe("2026-09-29T12:00:00.000Z");
    expect(r).toMatchObject({ deleted: 5015, chunks: 4, hitChunkCap: false });
    const del = calls.filter((c) => c.sql.startsWith("\n        DELETE") || c.sql.includes("DELETE FROM api_call_log"));
    expect(del.map((c) => c.params[0])).toEqual(["org-a", "org-a", "org-b", "2026-09-29T12:00:00.000Z"]);
    expect(del[3].sql).toContain("org_id IS NULL");
    for (const c of del) expect(c.params).toContain("2026-09-29T12:00:00.000Z");
  });

  it("stops at the chunk cap and says so", async () => {
    const execute = vi.fn(async (q: SQL) => {
      const { sql } = text(q);
      if (sql.includes("WITH RECURSIVE")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 5000 };
    });
    const r = await purgeExpiredApiCallLog(execute, new Date("2026-10-29T12:00:00Z"));
    expect(r).toMatchObject({ chunks: 400, deleted: 2_000_000, hitChunkCap: true });
  });
});
