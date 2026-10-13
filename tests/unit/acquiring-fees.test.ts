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

const usd = (stripe: number, revolut: number, unconverted = 0) => ({
  stripe_fee_usd_cents: stripe,
  revolut_fee_usd_cents: revolut,
  fee_usd_cents: stripe + revolut,
  unconverted_fee_count: unconverted,
});

describe("foldFeeRows — the fees we absorb, per org per month", () => {
  const rows = [
    { org_id: "org-a", acquirer: "stripe" as const, month: "2026-09", currency: "usd", fee: "290" },
    { org_id: "org-a", acquirer: "revolut" as const, month: "2026-09", currency: "usd", fee: 25 },
    { org_id: "org-a", acquirer: "stripe" as const, month: "2026-10", currency: "usd", fee: "60" },
    // EUR settlement era: 253 EUR cents at the transaction's own 0.867574 = 292 USD cents.
    { org_id: "org-b", acquirer: "stripe" as const, month: "2026-07", currency: "eur", fee: "253", exchange_rate: "0.867574" },
    { org_id: "org-b", acquirer: "stripe" as const, month: "2026-07", currency: "eur", fee: "40", exchange_rate: 0.8 },
    { org_id: null, acquirer: "stripe" as const, month: "2026-10", currency: "usd", fee: "200" },
    { org_id: "unknown", acquirer: "stripe" as const, month: "2026-10", currency: "usd", fee: "5" },
  ];
  const out = foldFeeRows(rows);

  it("splits each org's fees by month and acquirer, never merging currencies; a USD fee's USD figure is itself", () => {
    expect(out.orgs.map((o) => o.org_id)).toEqual(["org-a", "org-b"]);
    expect(out.orgs[0].months).toEqual([
      { month: "2026-09", currency: "usd", stripe_fee_cents: 290, revolut_fee_cents: 25, fee_cents: 315, ...usd(290, 25), unconverted_fee_cents: 0 },
      { month: "2026-10", currency: "usd", stripe_fee_cents: 60, revolut_fee_cents: 0, fee_cents: 60, ...usd(60, 0), unconverted_fee_cents: 0 },
    ]);
    expect(out.orgs[0].total).toEqual([
      { currency: "usd", stripe_fee_cents: 350, revolut_fee_cents: 25, fee_cents: 375, ...usd(350, 25), unconverted_fee_cents: 0 },
    ]);
  });

  it("converts a EUR Stripe fee with ITS OWN exchange_rate, fee by fee (USD = fee / rate)", () => {
    // round(253 / 0.867574) = 292, round(40 / 0.8) = 50
    expect(out.orgs[1].months).toEqual([
      { month: "2026-07", currency: "eur", stripe_fee_cents: 293, revolut_fee_cents: 0, fee_cents: 293, ...usd(342, 0), unconverted_fee_cents: 0 },
    ]);
    expect(out.orgs[1].usd_months).toEqual([{ month: "2026-07", ...usd(342, 0) }]);
    expect(out.orgs[1].usd_total).toEqual(usd(342, 0));
  });

  it("merges every currency of a month in USD", () => {
    const merged = foldFeeRows([
      { org_id: "o", acquirer: "stripe", month: "2026-08", currency: "eur", fee: "80", exchange_rate: "0.8" },
      { org_id: "o", acquirer: "stripe", month: "2026-08", currency: "usd", fee: "30" },
    ]);
    expect(merged.orgs[0].usd_months).toEqual([{ month: "2026-08", ...usd(130, 0) }]);
  });

  it("a non-USD fee with no rate is NAMED, never summed as USD (Stripe without exchange_rate, any non-USD Revolut fee)", () => {
    const o = foldFeeRows([
      { org_id: "o", acquirer: "stripe", month: "2026-08", currency: "eur", fee: "80", exchange_rate: null },
      { org_id: "o", acquirer: "revolut", month: "2026-08", currency: "gbp", fee: "20" },
      { org_id: "o", acquirer: "revolut", month: "2026-08", currency: "usd", fee: "25" },
    ]).orgs[0];
    expect(o.usd_months).toEqual([{ month: "2026-08", ...usd(0, 25, 2) }]);
    expect(o.months.find((m) => m.currency === "eur")).toMatchObject({ fee_cents: 80, fee_usd_cents: 0, unconverted_fee_cents: 80, unconverted_fee_count: 1 });
    expect(o.months.find((m) => m.currency === "gbp")).toMatchObject({ fee_cents: 20, fee_usd_cents: 0, unconverted_fee_cents: 20, unconverted_fee_count: 1 });
  });

  it("states an unattributable fee apart (null org and the 'unknown' sentinel), never dropped", () => {
    expect(out.unattributed.total).toEqual([
      { currency: "usd", stripe_fee_cents: 205, revolut_fee_cents: 0, fee_cents: 205, ...usd(205, 0), unconverted_fee_cents: 0 },
    ]);
    expect(out.unattributed.usd_total).toEqual(usd(205, 0));
  });

  it("the fleet total is every fee: orgs + unattributed, and the USD rows sum to the fleet USD total", () => {
    expect(out.fleet.total).toEqual([
      { currency: "eur", stripe_fee_cents: 293, revolut_fee_cents: 0, fee_cents: 293, ...usd(342, 0), unconverted_fee_cents: 0 },
      { currency: "usd", stripe_fee_cents: 555, revolut_fee_cents: 25, fee_cents: 580, ...usd(555, 25), unconverted_fee_cents: 0 },
    ]);
    const rowSum = [...out.orgs, out.unattributed]
      .flatMap((s) => s.months)
      .reduce((a, m) => a + m.fee_usd_cents, 0);
    expect(rowSum).toBe(out.fleet.usd_total.fee_usd_cents);
    expect(out.fleet.usd_total).toEqual(usd(897, 25));
  });

  it("no fees at all is empty, not a fabricated zero row", () => {
    expect(foldFeeRows([])).toEqual({
      object: "acquiring_fees_by_month",
      orgs: [],
      unattributed: { months: [], total: [], usd_months: [], usd_total: usd(0, 0) },
      fleet: { months: [], total: [], usd_months: [], usd_total: usd(0, 0) },
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
