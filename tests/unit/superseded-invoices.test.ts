import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});
vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

import { voidSupersededChargeInvoicesFleet } from "../../src/lib/superseded-invoices";

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearQueues();
});

const refused = (id: string, customer: string) => ({
  id,
  customer,
  created: 1793121514,
  status: "open",
  attempted: true,
  collection_method: "charge_automatically",
  metadata: { org_id: "org-1" },
});

describe("voidSupersededChargeInvoicesFleet (boot, history)", () => {
  it("voids a refused attempt only when the customer paid LATER", async () => {
    const stripe = {
      invoices: {
        list: vi.fn(() =>
          (async function* () {
            yield refused("in_settled", "cus_paid_later");
            yield refused("in_still_owed", "cus_nothing_after");
          })()
        ),
        voidInvoice: vi.fn(),
      },
    };
    dbMock.queueSelect("payment_intents", [{ id: "pi_later" }]);
    dbMock.queueSelect("payment_intents", []);

    const voided = await voidSupersededChargeInvoicesFleet(stripe as never);

    expect(voided).toEqual(["in_settled"]);
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledTimes(1);
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledWith(
      "in_settled",
      {},
      { idempotencyKey: "void-superseded:in_settled" }
    );
  });
});
