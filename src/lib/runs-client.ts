/**
 * HTTP client for runs-service. Used by the webhook fee declaration path to
 * record Stripe-incurred costs (processing, refund, dispute, payout-failure)
 * as platform-runs in runs-service.
 *
 * All three calls accept the same caller-supplied idempotency key
 * (`stripe:<balance_transaction_id>`) so Stripe webhook redelivery is safe.
 */

const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "";
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "";

const SERVICE_NAME = "stripe-service";
const FEATURE_SLUG = "stripe-webhook";

/**
 * Every run this service opens declares an acquiring fee (Stripe or Revolut):
 * spend that produces no outcome BY DESIGN. runs-service names it a SUPPORT
 * function so its cost never rides an outcome and Research's cost per outcome
 * reads on outcome spend only (COST-SUPPORT-1024). A run of ours that ever
 * produces an outcome must not go through `createPlatformRun` as-is: it would
 * be marked payment fees and refused its declaration (409 run_marked_support).
 */
export const PAYMENT_FEES_SUPPORT = {
  kind: "payment_fees",
  reason: "Card acquiring fee (Stripe / Revolut) absorbed by the platform: spend with no outcome by design.",
} as const;

/** First day of the runs ledger: past runs are marked from here on. */
export const SUPPORT_MARK_SINCE = "2026-02-02T00:00:00.000Z";

export interface PlatformRun {
  id: string;
  organizationId: string | null;
  userId: string | null;
  serviceName: string;
  taskName: string;
  status: string;
  idempotencyKey: string | null;
}

export interface CreatePlatformRunInput {
  taskName: string;
  idempotencyKey: string;
  orgId: string | null;
}

export interface AddPlatformRunCostInput {
  runId: string;
  costName: string;
  costSource: "platform" | "org";
  quantity: number;
  idempotencyKey: string;
}

export interface UpdatePlatformRunStatusInput {
  runId: string;
  status: "completed" | "failed";
}

function baseHeaders(orgId: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": RUNS_SERVICE_API_KEY,
    "x-service-name": SERVICE_NAME,
    "x-feature-slug": FEATURE_SLUG,
  };
  if (orgId) headers["x-org-id"] = orgId;
  return headers;
}

export async function createPlatformRun(
  input: CreatePlatformRunInput
): Promise<PlatformRun> {
  const url = `${RUNS_SERVICE_URL}/v1/platform-runs`;
  const response = await fetch(url, {
    method: "POST",
    headers: baseHeaders(input.orgId),
    body: JSON.stringify({
      serviceName: SERVICE_NAME,
      taskName: input.taskName,
      idempotencyKey: input.idempotencyKey,
      support: PAYMENT_FEES_SUPPORT,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `runs-service POST /v1/platform-runs failed: ${response.status} - ${errorText}`
    );
  }

  return (await response.json()) as PlatformRun;
}

export async function addPlatformRunCost(
  input: AddPlatformRunCostInput
): Promise<void> {
  const url = `${RUNS_SERVICE_URL}/v1/platform-runs/${encodeURIComponent(input.runId)}/costs`;
  const response = await fetch(url, {
    method: "POST",
    headers: baseHeaders(null),
    body: JSON.stringify({
      items: [
        {
          costName: input.costName,
          costSource: input.costSource,
          quantity: input.quantity,
          status: "actual",
          idempotencyKey: input.idempotencyKey,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `runs-service POST /v1/platform-runs/${input.runId}/costs failed: ${response.status} - ${errorText}`
    );
  }
}

export async function updatePlatformRunStatus(
  input: UpdatePlatformRunStatusInput
): Promise<void> {
  const url = `${RUNS_SERVICE_URL}/v1/platform-runs/${encodeURIComponent(input.runId)}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: baseHeaders(null),
    body: JSON.stringify({ status: input.status }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `runs-service PATCH /v1/platform-runs/${input.runId} failed: ${response.status} - ${errorText}`
    );
  }
}

export interface SupportMarkResult {
  markedCount: number;
  alreadyMarkedCount: number;
  declaresOutcomesCount: number;
}

/**
 * Marks every PAST run of this service since the ledger's first day as
 * payment-fees support, through runs-service's owner door (our own runs only).
 * Idempotent: an already marked run writes nothing, and a run that declared a
 * produced outcome is left untouched and counted (`declaresOutcomesCount`).
 * Covers runs created before the mark existed AND idempotent replays, which
 * runs-service answers with the existing run and ignores `support` on.
 */
export async function markPastRunsPaymentFeesSupport(): Promise<SupportMarkResult> {
  const url = `${RUNS_SERVICE_URL}/v1/platform-runs/support-marks/apply`;
  const response = await fetch(url, {
    method: "POST",
    headers: baseHeaders(null),
    body: JSON.stringify({
      ...PAYMENT_FEES_SUPPORT,
      markedBy: SERVICE_NAME,
      startedAfter: SUPPORT_MARK_SINCE,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `runs-service POST /v1/platform-runs/support-marks/apply failed: ${response.status} - ${errorText}`
    );
  }

  return (await response.json()) as SupportMarkResult;
}
