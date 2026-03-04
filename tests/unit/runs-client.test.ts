import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { createRun, updateRun, addCosts } from "../../src/lib/runs-client";

describe("runs-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createRun", () => {
    it("sends x-org-id and x-user-id as headers, not in body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "run_123", organizationId: "org_abc", status: "running" }),
      });

      await createRun({
        orgId: "org_abc",
        userId: "user_xyz",
        serviceName: "stripe-service",
        taskName: "create-checkout-session",
        parentRunId: "parent_run_1",
      });

      const [url, options] = mockFetch.mock.calls[0];
      const headers = options.headers as Record<string, string>;
      const body = JSON.parse(options.body as string);

      expect(headers["x-org-id"]).toBe("org_abc");
      expect(headers["x-user-id"]).toBe("user_xyz");
      expect(headers["x-run-id"]).toBe("parent_run_1");

      // orgId, userId, parentRunId should NOT be in body
      expect(body).not.toHaveProperty("orgId");
      expect(body).not.toHaveProperty("userId");
      expect(body).not.toHaveProperty("parentRunId");

      // serviceName, taskName should be in body
      expect(body.serviceName).toBe("stripe-service");
      expect(body.taskName).toBe("create-checkout-session");
    });

    it("omits x-run-id header when parentRunId is undefined", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "run_123" }),
      });

      await createRun({
        orgId: "org_abc",
        userId: "user_xyz",
        serviceName: "stripe-service",
        taskName: "test-task",
      });

      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
      expect(headers["x-org-id"]).toBe("org_abc");
      expect(headers["x-user-id"]).toBe("user_xyz");
      expect(headers).not.toHaveProperty("x-run-id");
    });
  });

  describe("updateRun", () => {
    it("sends identity headers", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "run_123", status: "completed" }),
      });

      await updateRun("run_123", "completed", {
        orgId: "org_abc",
        userId: "user_xyz",
        runId: "run_123",
      });

      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
      expect(headers["x-org-id"]).toBe("org_abc");
      expect(headers["x-user-id"]).toBe("user_xyz");
      expect(headers["x-run-id"]).toBe("run_123");
    });
  });

  describe("addCosts", () => {
    it("sends identity headers", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ costs: [] }),
      });

      await addCosts(
        "run_123",
        [{ costName: "stripe-checkout-session", quantity: 1, costSource: "platform" }],
        { orgId: "org_abc", userId: "user_xyz", runId: "run_123" }
      );

      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
      expect(headers["x-org-id"]).toBe("org_abc");
      expect(headers["x-user-id"]).toBe("user_xyz");
      expect(headers["x-run-id"]).toBe("run_123");
    });
  });
});
