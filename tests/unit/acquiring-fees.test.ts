import { describe, it, expect, vi } from "vitest";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});
vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

import {
  foldFeeRows,
  recordStripeFeeTransaction,
  backfillStripeFeeTransactions,
} from "../../src/lib/acquiring-fees";

describe("foldFeeRows — the fees we absorb, per org per month", () => {
  const rows = [
    { org_id: "org-a", acquirer: "stripe" as const, month: "2026-09", currency: "usd", fee: "290" },
    { org_id: "org-a", acquirer: "revolut" as const, month: "2026-09", currency: "usd", fee: 25 },
    { org_id: "org-a", acquirer: "stripe" as const, month: "2026-10", currency: "usd", fee: "60" },
    { org_id: "org-b", acquirer: "stripe" as const, month: "2026-10", currency: "eur", fee: "40" },
    { org_id: null, acquirer: "stripe" as const, month: "2026-10", currency: "usd", fee: "200" },
    { org_id: "unknown", acquirer: "stripe" as const, month: "2026-10", currency: "usd", fee: "5" },
  ];
  const out = foldFeeRows(rows);

  it("splits each org's fees by month and acquirer, never merging currencies", () => {
    expect(out.orgs.map((o) => o.org_id)).toEqual(["org-a", "org-b"]);
    expect(out.orgs[0].months).toEqual([
      { month: "2026-09", currency: "usd", stripe_fee_cents: 290, revolut_fee_cents: 25, fee_cents: 315 },
      { month: "2026-10", currency: "usd", stripe_fee_cents: 60, revolut_fee_cents: 0, fee_cents: 60 },
    ]);
    expect(out.orgs[0].total).toEqual([
      { currency: "usd", stripe_fee_cents: 350, revolut_fee_cents: 25, fee_cents: 375 },
    ]);
    expect(out.orgs[1].total).toEqual([
      { currency: "eur", stripe_fee_cents: 40, revolut_fee_cents: 0, fee_cents: 40 },
    ]);
  });

  it("states an unattributable fee apart (null org and the 'unknown' sentinel), never dropped", () => {
    expect(out.unattributed.total).toEqual([
      { currency: "usd", stripe_fee_cents: 205, revolut_fee_cents: 0, fee_cents: 205 },
    ]);
  });

  it("the fleet total is every fee: orgs + unattributed", () => {
    expect(out.fleet.total).toEqual([
      { currency: "eur", stripe_fee_cents: 40, revolut_fee_cents: 0, fee_cents: 40 },
      { currency: "usd", stripe_fee_cents: 555, revolut_fee_cents: 25, fee_cents: 580 },
    ]);
  });

  it("no fees at all is empty, not a fabricated zero row", () => {
    expect(foldFeeRows([])).toEqual({
      object: "acquiring_fees_by_month",
      orgs: [],
      unattributed: { months: [], total: [] },
      fleet: { months: [], total: [] },
    });
  });
});

describe("Stripe fee mirror", () => {
  it("mirrors a fee-bearing balance transaction, keyed on its id", async () => {
    await recordStripeFeeTransaction({
      id: "txn_1", type: "charge", source: "ch_1", fee: 290, currency: "USD", created: 1790000000,
    } as never);
    expect(dbMock.lastInsertValues("stripe_fee_transactions")).toMatchObject({
      id: "txn_1", type: "charge", source: "ch_1", fee: 290, currency: "usd", createdStripe: 1790000000,
    });
  });

  it("back-fill keeps only fee-bearing transactions", async () => {
    const list = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { id: "txn_a", type: "charge", source: "ch_a", fee: 30, currency: "usd", created: 1 };
        yield { id: "txn_b", type: "payout", source: "po_b", fee: 0, currency: "usd", created: 2 };
      },
    }));
    expect(await backfillStripeFeeTransactions({ balanceTransactions: { list } } as never)).toBe(1);
  });
});
