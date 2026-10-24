import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("runs-client payment-fees support marks", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    process.env.RUNS_SERVICE_URL = "http://runs.test";
    process.env.RUNS_SERVICE_API_KEY = "k";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks every fee run payment_fees support at creation", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: "run_1" }), { status: 200 }));
    const { createPlatformRun } = await import("../../src/lib/runs-client");
    await createPlatformRun({ taskName: "charge.succeeded", idempotencyKey: "stripe:txn_1", orgId: null });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://runs.test/v1/platform-runs");
    const body = JSON.parse(init.body);
    expect(body.support.kind).toBe("payment_fees");
    expect(body.support.reason.length).toBeGreaterThan(0);
    expect(init.headers["x-org-id"]).toBeUndefined();
  });

  it("bulk-marks past runs since 2026-02-02 through the owner door", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ markedCount: 3, alreadyMarkedCount: 1, declaresOutcomesCount: 0 }), { status: 200 })
    );
    const { markPastRunsPaymentFeesSupport } = await import("../../src/lib/runs-client");
    const out = await markPastRunsPaymentFeesSupport();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://runs.test/v1/platform-runs/support-marks/apply");
    expect(init.headers["x-service-name"]).toBe("stripe-service");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ kind: "payment_fees", markedBy: "stripe-service", startedAfter: "2026-02-02T00:00:00.000Z" });
    expect(body.runIds).toBeUndefined();
    expect(out.markedCount).toBe(3);
  });

  it("fails loud when runs-service refuses the mark", async () => {
    fetchMock.mockResolvedValueOnce(new Response("too_many_runs", { status: 422 }));
    const { markPastRunsPaymentFeesSupport } = await import("../../src/lib/runs-client");
    await expect(markPastRunsPaymentFeesSupport()).rejects.toThrow(/422/);
  });
});
