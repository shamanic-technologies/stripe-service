/**
 * HTTP client for runs-service
 * Vendored from @mcpfactory/runs-client
 */

const RUNS_SERVICE_URL =
  process.env.RUNS_SERVICE_URL || "http://localhost:3006";
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "";

// --- Types ---

export interface Run {
  id: string;
  parentRunId: string | null;
  organizationId: string;
  userId: string | null;
  brandId: string | null;
  campaignId: string | null;
  serviceName: string;
  taskName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunCost {
  id: string;
  runId: string;
  costName: string;
  quantity: string;
  unitCostInUsdCents: string;
  totalCostInUsdCents: string;
  createdAt: string;
}

export interface CreateRunParams {
  orgId: string;
  userId: string;
  serviceName: string;
  taskName: string;
  parentRunId?: string;
  brandId?: string;
  campaignId?: string;
}

export interface CostItem {
  costName: string;
  quantity: number;
  costSource: "platform" | "org";
}

export interface WorkflowContext {
  campaignId?: string;
  brandId?: string;
  workflowName?: string;
}

export interface IdentityContext {
  orgId: string;
  userId: string;
  runId?: string;
  workflow?: WorkflowContext;
}

// --- HTTP helpers ---

async function runsRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; identity?: IdentityContext } = {}
): Promise<T> {
  const { method = "GET", body, identity } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": RUNS_SERVICE_API_KEY,
  };

  if (identity) {
    headers["x-org-id"] = identity.orgId;
    headers["x-user-id"] = identity.userId;
    if (identity.runId) {
      headers["x-run-id"] = identity.runId;
    }
    if (identity.workflow?.campaignId) {
      headers["x-campaign-id"] = identity.workflow.campaignId;
    }
    if (identity.workflow?.brandId) {
      headers["x-brand-id"] = identity.workflow.brandId;
    }
    if (identity.workflow?.workflowName) {
      headers["x-workflow-name"] = identity.workflow.workflowName;
    }
  }

  const response = await fetch(`${RUNS_SERVICE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `runs-service ${method} ${path} failed: ${response.status} - ${errorText}`
    );
  }

  return response.json() as Promise<T>;
}

// --- Public API ---

export async function createRun(params: CreateRunParams): Promise<Run> {
  const { orgId, userId, parentRunId, ...body } = params;
  return runsRequest<Run>("/v1/runs", {
    method: "POST",
    body,
    identity: { orgId, userId, runId: parentRunId },
  });
}

export async function updateRun(
  runId: string,
  status: "completed" | "failed",
  identity: IdentityContext,
  error?: string
): Promise<Run> {
  return runsRequest<Run>(`/v1/runs/${runId}`, {
    method: "PATCH",
    body: { status, error },
    identity,
  });
}

export async function addCosts(
  runId: string,
  items: CostItem[],
  identity: IdentityContext
): Promise<{ costs: RunCost[] }> {
  return runsRequest<{ costs: RunCost[] }>(`/v1/runs/${runId}/costs`, {
    method: "POST",
    body: { items },
    identity,
  });
}
