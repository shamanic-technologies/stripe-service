import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

import {
  addSums,
  foldPayingAccountRows,
  foldReturnedRows,
  mergeGrowth,
  payingAccounts,
  platformReturns,
  revolutPlatformPaid,
  sumsToPaidRows,
  type PaidBucketRow,
  type PayingAccountRow,
  type ReturnedBucketRow,
} from "../../src/lib/platform-billing-stats";

/**
 * `platformReturns` fires the refunds + disputes queries concurrently via
 * Promise.all, so queue them by table name rather than by call order.
 */
function queueReturns(
  refundRows: ReturnedBucketRow[],
  disputeRows: ReturnedBucketRow[]
) {
  dbMock.queueSelect("refunds", refundRows);
  dbMock.queueSelect("disputes", disputeRows);
}

function bucket(month: string, week: string, cents: string): ReturnedBucketRow {
  return {
    month: new Date(`${month}T00:00:00Z`),
    week: new Date(`${week}T00:00:00Z`),
    cents,
  };
}

/** Collect every bound parameter value out of a drizzle SQL condition tree. */
function sqlParams(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== "object") return out;
  const n = node as Record<string, unknown>;
  if ("value" in n && "encoder" in n) out.push(n.value);
  const chunks = n.queryChunks;
  if (Array.isArray(chunks)) for (const chunk of chunks) sqlParams(chunk, out);
  return out;
}

function paid(period: string, cents: string | null): PaidBucketRow {
  return { period: new Date(`${period}T00:00:00Z`), paid_cents: cents };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("foldReturnedRows", () => {
  it("sums the platform total and both grains independently", () => {
    // Two weeks of the same month: the month total is their sum.
    const sums = foldReturnedRows([
      bucket("2026-07-01", "2026-07-20", "5000"),
      bucket("2026-07-01", "2026-07-27", "1000"),
    ]);

    expect(sums.total).toBe(6000n);
    expect(sums.byMonth.get("2026-07-01")).toBe(6000n);
    expect(sums.byWeek.get("2026-07-20")).toBe(5000n);
    expect(sums.byWeek.get("2026-07-27")).toBe(1000n);
  });

  it("returns zeroed sums when nothing was returned", () => {
    const sums = foldReturnedRows([]);

    expect(sums.total).toBe(0n);
    expect(sums.byMonth.size).toBe(0);
    expect(sums.byWeek.size).toBe(0);
  });

  it("throws rather than dropping money with no period", () => {
    expect(() =>
      foldReturnedRows([{ month: null, week: null, cents: "1000" }])
    ).toThrow(/missing created_stripe/);
  });
});

describe("platformReturns", () => {
  it("keeps refunds and lost disputes as separate sums", async () => {
    queueReturns(
      [bucket("2026-07-01", "2026-07-20", "5000")],
      [bucket("2026-06-01", "2026-06-01", "2500")]
    );

    const returns = await platformReturns();

    expect(returns.refunded.total).toBe(5000n);
    expect(returns.disputedLost.total).toBe(2500n);
    expect(returns.refunded.byMonth.get("2026-07-01")).toBe(5000n);
    expect(returns.disputedLost.byMonth.get("2026-06-01")).toBe(2500n);
  });

  it("reports zeros for an account with no refunds and no disputes", async () => {
    queueReturns([], []);

    const returns = await platformReturns();

    expect(returns.refunded.total).toBe(0n);
    expect(returns.disputedLost.total).toBe(0n);
  });

  it("only counts a SETTLED refund and a LOST dispute", async () => {
    // The "money is really gone" rule lives in the WHERE clause, so assert it
    // there: a refund that REVERTED (`failed` / `canceled`) and a dispute that
    // is open or won never reach the sums.
    queueReturns([], []);

    await platformReturns();

    expect(sqlParams(dbMock.lastSelectWhere("refunds"))).toContain("succeeded");
    expect(sqlParams(dbMock.lastSelectWhere("disputes"))).toContain("lost");
  });
});

describe("mergeGrowth", () => {
  it("leaves net === paid when nothing was returned", () => {
    const out = mergeGrowth(
      [paid("2026-04-01", "5000"), paid("2026-05-01", "7500")],
      new Map(),
      new Map(),
      new Map()
    );

    expect(out).toEqual([
      {
        period: "2026-04-01",
        paid_cents: "5000",
        refunded_cents: "0",
        disputed_lost_cents: "0",
        returned_cents: "0",
        net_cents: "5000",
        paying_accounts: 0,
        first_time_paying_accounts: 0,
      },
      {
        period: "2026-05-01",
        paid_cents: "7500",
        refunded_cents: "0",
        disputed_lost_cents: "0",
        returned_cents: "0",
        net_cents: "7500",
        paying_accounts: 0,
        first_time_paying_accounts: 0,
      },
    ]);
  });

  it("subtracts a FULL refund from the period it happened in, not the payment's", () => {
    const out = mergeGrowth(
      [paid("2026-04-01", "5000"), paid("2026-05-01", "7500")],
      new Map([["2026-05-01", 5000n]]),
      new Map(),
      new Map()
    );

    // April keeps its gross intact — the payment is never mutated or hidden.
    expect(out[0]).toMatchObject({ paid_cents: "5000", net_cents: "5000" });
    expect(out[1]).toMatchObject({
      paid_cents: "7500",
      refunded_cents: "5000",
      returned_cents: "5000",
      net_cents: "2500",
    });
  });

  it("subtracts only its own amount for a PARTIAL refund", () => {
    const out = mergeGrowth(
      [paid("2026-05-01", "7500")],
      new Map([["2026-05-01", 1500n]]),
      new Map(),
      new Map()
    );

    expect(out[0]).toMatchObject({
      paid_cents: "7500",
      refunded_cents: "1500",
      net_cents: "6000",
    });
  });

  it("counts a LOST dispute exactly like a refund, in its own column", () => {
    const out = mergeGrowth(
      [paid("2026-05-01", "7500")],
      new Map([["2026-05-01", 1000n]]),
      new Map([["2026-05-01", 2000n]]),
      new Map()
    );

    expect(out[0]).toEqual({
      period: "2026-05-01",
      paid_cents: "7500",
      refunded_cents: "1000",
      disputed_lost_cents: "2000",
      returned_cents: "3000",
      net_cents: "4500",
      paying_accounts: 0,
      first_time_paying_accounts: 0,
    });
  });

  it("emits a returns-only period with real zeros on the gross side", () => {
    // The refund landed a month after the payment it reverses: its own period
    // took in nothing, so net goes negative rather than back-dating the return.
    const out = mergeGrowth(
      [paid("2026-04-01", "5000")],
      new Map([["2026-05-01", 5000n]]),
      new Map(),
      new Map()
    );

    expect(out).toEqual([
      {
        period: "2026-04-01",
        paid_cents: "5000",
        refunded_cents: "0",
        disputed_lost_cents: "0",
        returned_cents: "0",
        net_cents: "5000",
        paying_accounts: 0,
        first_time_paying_accounts: 0,
      },
      {
        period: "2026-05-01",
        paid_cents: "0",
        refunded_cents: "5000",
        disputed_lost_cents: "0",
        returned_cents: "5000",
        net_cents: "-5000",
        paying_accounts: 0,
        first_time_paying_accounts: 0,
      },
    ]);
  });

  it("keeps sum(bucket net) equal to the all-time net", () => {
    const paidRows = [paid("2026-04-01", "5000"), paid("2026-05-01", "7500")];
    const refunded = new Map([
      ["2026-05-01", 1500n],
      ["2026-06-01", 1000n],
    ]);
    const out = mergeGrowth(paidRows, refunded, new Map(), new Map());

    const grossTotal = 5000n + 7500n;
    const returnedTotal = 1500n + 1000n;
    const bucketNetSum = out.reduce((acc, b) => acc + BigInt(b.net_cents), 0n);

    expect(bucketNetSum).toBe(grossTotal - returnedTotal);
  });

  it("treats a null gross sum as zero", () => {
    const out = mergeGrowth(
      [paid("2026-05-01", null)],
      new Map(),
      new Map(),
      new Map()
    );

    expect(out[0]).toMatchObject({ paid_cents: "0", net_cents: "0" });
  });
});


describe("addSums", () => {
  it("adds two roll-ups per grain without mutating either", () => {
    const a = foldReturnedRows([bucket("2026-08-01", "2026-08-24", "1000")]);
    const b = foldReturnedRows([
      bucket("2026-08-01", "2026-08-31", "500"),
      bucket("2026-09-01", "2026-09-07", "250"),
    ]);

    const merged = addSums(a, b);

    expect(merged.total).toBe(1750n);
    // Same month from both sides collapses; the weeks stay apart.
    expect(merged.byMonth.get("2026-08-01")).toBe(1500n);
    expect(merged.byMonth.get("2026-09-01")).toBe(250n);
    expect(merged.byWeek.get("2026-08-24")).toBe(1000n);
    expect(merged.byWeek.get("2026-08-31")).toBe(500n);
    // Inputs untouched.
    expect(a.total).toBe(1000n);
    expect(a.byMonth.get("2026-08-01")).toBe(1000n);
  });
});

describe("platformReturns across acquirers", () => {
  it("folds Revolut refunds into the same refunded roll-up as Stripe's", async () => {
    queueReturns([bucket("2026-08-01", "2026-08-24", "1500")], []);
    dbMock.queueSelect("revolut_orders", [
      bucket("2026-08-01", "2026-08-31", "50000"),
    ]);

    const returns = await platformReturns();

    expect(returns.refunded.total).toBe(51500n);
    expect(returns.refunded.byMonth.get("2026-08-01")).toBe(51500n);
    expect(returns.refunded.byWeek.get("2026-08-24")).toBe(1500n);
    expect(returns.refunded.byWeek.get("2026-08-31")).toBe(50000n);
    // Revolut has no dispute silver yet, so lost disputes stay Stripe-only.
    expect(returns.disputedLost.total).toBe(0n);
  });

  it("only counts a Revolut order in the settled state", async () => {
    queueReturns([], []);
    dbMock.queueSelect("revolut_orders", []);

    await platformReturns();

    const params = sqlParams(dbMock.lastSelectWhere("revolut_orders"));
    expect(params).toContain("refund");
    expect(params).toContain("completed");
  });
});

describe("revolutPlatformPaid", () => {
  it("sums completed payment orders per grain", async () => {
    dbMock.queueSelect("revolut_orders", [
      bucket("2026-08-01", "2026-08-24", "50000"),
      bucket("2026-08-01", "2026-08-31", "600"),
    ]);

    const paid = await revolutPlatformPaid();

    expect(paid.total).toBe(50600n);
    expect(paid.byMonth.get("2026-08-01")).toBe(50600n);
    expect(paid.byWeek.get("2026-08-24")).toBe(50000n);

    const params = sqlParams(dbMock.lastSelectWhere("revolut_orders"));
    expect(params).toContain("payment");
    expect(params).toContain("completed");
  });
});

describe("sumsToPaidRows", () => {
  it("feeds a second acquirer's payments through the same merge as the first", () => {
    const revolut = new Map<string, bigint>([["2026-08-01", 50000n]]);

    const merged = mergeGrowth(
      [paid("2026-08-01", "12500"), ...sumsToPaidRows(revolut)],
      new Map(),
      new Map(),
      new Map()
    );

    expect(merged).toEqual([
      {
        period: "2026-08-01",
        paid_cents: "62500",
        refunded_cents: "0",
        disputed_lost_cents: "0",
        returned_cents: "0",
        net_cents: "62500",
        paying_accounts: 0,
        first_time_paying_accounts: 0,
      },
    ]);
  });
});


/**
 * Compile a drizzle `sql` template to the text Postgres would actually receive
 * plus its bound params, so an assertion reads the real query rather than a
 * reconstruction of it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function compiled(query: any): { sql: string; params: unknown[] } {
  const { sql: text, params } = new PgDialect().sqlToQuery(query);
  return { sql: text, params };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A row of the grouped paying-account query, as Postgres yields it. */
function accountRow(
  grain: string,
  period: string | null,
  paying: number,
  firstTime: number
): PayingAccountRow {
  return {
    grain,
    period: period === null ? null : new Date(`${period}T00:00:00Z`),
    paying,
    first_time: firstTime,
  };
}

describe("foldPayingAccountRows", () => {
  it("splits the three grain arms into the total and both grains", () => {
    const out = foldPayingAccountRows([
      accountRow("total", null, 33, 33),
      accountRow("month", "2026-08-01", 9, 2),
      accountRow("week", "2026-08-24", 4, 1),
      accountRow("week", "2026-08-31", 5, 0),
    ]);

    expect(out.total).toBe(33);
    expect(out.byMonth.get("2026-08-01")).toEqual({ paying: 9, firstTime: 2 });
    expect(out.byWeek.get("2026-08-24")).toEqual({ paying: 4, firstTime: 1 });
    expect(out.byWeek.get("2026-08-31")).toEqual({ paying: 5, firstTime: 0 });
  });

  it("reads the total from its own arm rather than summing first-timers", () => {
    // Summing in TypeScript would make sum(firstTime) === total an identity we
    // imposed; querying it separately keeps it a real check on the data.
    const out = foldPayingAccountRows([
      accountRow("total", null, 3, 3),
      accountRow("month", "2026-08-01", 2, 1),
    ]);

    expect(out.total).toBe(3);
  });

  it("throws rather than dropping a bucket with no period", () => {
    expect(() =>
      foldPayingAccountRows([accountRow("week", null, 4, 1)])
    ).toThrow(/no period/);
  });

  it("throws on a grain it does not know", () => {
    expect(() =>
      foldPayingAccountRows([accountRow("day", "2026-08-24", 1, 1)])
    ).toThrow(/unknown grain/);
  });

  it("reads counts that arrive as strings", () => {
    const out = foldPayingAccountRows([
      { grain: "total", period: null, paying: "7", first_time: "7" },
      {
        grain: "week",
        period: "2026-09-07T00:00:00.000Z",
        paying: "2",
        first_time: "1",
      },
    ]);

    expect(out.total).toBe(7);
    expect(out.byWeek.get("2026-09-07")).toEqual({ paying: 2, firstTime: 1 });
  });
});

describe("payingAccounts", () => {
  beforeEach(() => {
    dbMock.clearQueues();
  });

  it("counts who PAID across both acquirers, excluding unattributable rows", async () => {
    dbMock.queueExecute([
      accountRow("total", null, 33, 33),
      accountRow("month", "2026-08-01", 9, 2),
      accountRow("week", "2026-08-24", 4, 1),
    ]);

    const out = await payingAccounts();

    expect(out.total).toBe(33);
    expect(out.byWeek.get("2026-08-24")).toEqual({ paying: 4, firstTime: 1 });

    const query = compiled(dbMock.db.execute.mock.calls[0][0]);

    // Both acquirers, settled only, and the same predicates the money uses.
    expect(query.sql).toContain('"payment_intents"');
    expect(query.sql).toContain('"revolut_orders"');
    expect(query.sql).toContain("'succeeded'");
    expect(query.sql).toContain("'payment'");
    expect(query.params).toContain("completed");
    // The unattributable sentinel is excluded from the counts (its money is
    // still counted by the figures next to it).
    expect(query.params).toContain("unknown");
    // Both grains come off the SAME settled set as each other.
    expect(query.sql).toContain("date_trunc('month'");
    expect(query.sql).toContain("date_trunc('week'");
  });
});

describe("mergeGrowth account counts", () => {
  it("carries the counts on the same buckets as the money", () => {
    const out = mergeGrowth(
      [paid("2026-08-01", "50000")],
      new Map(),
      new Map(),
      new Map([["2026-08-01", { paying: 9, firstTime: 2 }]])
    );

    expect(out[0]).toMatchObject({
      paid_cents: "50000",
      paying_accounts: 9,
      first_time_paying_accounts: 2,
    });
  });

  it("emits real zeros for a period with money but no attributable account", () => {
    const out = mergeGrowth(
      [paid("2026-08-01", "50000")],
      new Map(),
      new Map(),
      new Map()
    );

    expect(out[0]).toMatchObject({
      paying_accounts: 0,
      first_time_paying_accounts: 0,
    });
  });

  it("keeps sum(first_time_paying_accounts) equal to the platform total", () => {
    const accounts = new Map([
      ["2026-06-01", { paying: 8, firstTime: 5 }],
      ["2026-07-01", { paying: 9, firstTime: 3 }],
      ["2026-08-01", { paying: 9, firstTime: 2 }],
    ]);
    const out = mergeGrowth(
      [
        paid("2026-06-01", "1000"),
        paid("2026-07-01", "2000"),
        paid("2026-08-01", "3000"),
      ],
      new Map(),
      new Map(),
      accounts
    );

    const firstTimeSum = out.reduce(
      (acc, b) => acc + b.first_time_paying_accounts,
      0
    );

    expect(firstTimeSum).toBe(10);
    // Distinct-account counts are NOT additive the way money is: an account
    // that pays every month is in every month's paying_accounts.
    expect(out.reduce((acc, b) => acc + b.paying_accounts, 0)).toBe(26);
  });
});
