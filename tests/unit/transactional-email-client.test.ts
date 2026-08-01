import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  PAYMENT_METHOD_REMOVED_EVENT_TYPE,
  EMAIL_TEMPLATES,
  sendStaffEmail,
  deployEmailTemplates,
} from "../../src/lib/transactional-email-client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ORG_ID = "a2bc915a-7430-4842-a911-a29d3430d4ea";

let fetchMock: ReturnType<typeof vi.fn>;

function lastRequest(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url: call[0], init: call[1] };
}

function headersOfLastRequest(): Record<string, string> {
  return lastRequest().init.headers as Record<string, string>;
}

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.TRANSACTIONAL_EMAIL_SERVICE_URL = "https://email.internal";
  process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "test-key";
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
  delete process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
});

describe("payment_method_removed event key", () => {
  // Frozen across stripe-service and transactional-email-service: the template
  // is resolved by `name == eventType`, and staff routing keys on the same
  // string. Drift here mails the customer instead of staff.
  it("is exactly the string both services agree on", () => {
    expect(PAYMENT_METHOD_REMOVED_EVENT_TYPE).toBe("payment_method_removed");
  });

  it("ships a template registered under that exact name", () => {
    expect(EMAIL_TEMPLATES.map((t) => t.name)).toEqual([
      "payment_method_removed",
    ]);
  });

  it("renders every variable the notifier supplies and nothing else", () => {
    const template = EMAIL_TEMPLATES[0];
    const supplied = new Set([
      "orgId",
      "orgLabel",
      "customerId",
      "customerLabel",
      "customerEmail",
      "paymentMethodId",
      "paymentMethodLabel",
      "cardsRemaining",
      "cardsRemainingLabel",
      "impact",
      "removedAt",
      "eventId",
    ]);

    for (const body of [template.subject, template.htmlBody, template.textBody]) {
      for (const [, name] of body.matchAll(/\{\{(\w+)\}\}/g)) {
        expect(supplied.has(name), `unknown template variable ${name}`).toBe(
          true
        );
      }
    }
  });

  it("carries the organisation, the payment method and the remaining count", () => {
    const { subject, htmlBody, textBody } = EMAIL_TEMPLATES[0];
    for (const body of [htmlBody, textBody]) {
      expect(body).toContain("{{orgId}}");
      expect(body).toContain("{{paymentMethodLabel}}");
      expect(body).toContain("{{cardsRemaining}}");
    }
    expect(subject).toContain("{{cardsRemainingLabel}}");
  });

  it("uses no em-dash anywhere in the copy", () => {
    for (const t of EMAIL_TEMPLATES) {
      expect(`${t.subject}${t.htmlBody}${t.textBody}`).not.toContain("—");
    }
  });
});

describe("sendStaffEmail", () => {
  it("sends an organisation and a run id but never invents a user id", async () => {
    await sendStaffEmail({
      eventType: PAYMENT_METHOD_REMOVED_EVENT_TYPE,
      orgId: ORG_ID,
      metadata: { orgId: ORG_ID },
    });

    const { url, init } = lastRequest();
    const headers = headersOfLastRequest();
    expect(url).toBe("https://email.internal/platform-send");
    expect(init.method).toBe("POST");
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["x-org-id"]).toBe(ORG_ID);
    expect(headers["x-run-id"]).toMatch(UUID_RE);
    expect(headers).not.toHaveProperty("x-user-id");
  });

  // The send carries no user, so it MUST go to the user-less route. `/send` is
  // guarded by requireIdentityHeaders and 400s without `x-user-id`; because the
  // caller is fire-and-forget, hitting it sends nothing and reports nothing.
  it("never targets the identity-guarded customer-facing send route", async () => {
    await sendStaffEmail({
      eventType: PAYMENT_METHOD_REMOVED_EVENT_TYPE,
      orgId: ORG_ID,
      metadata: { orgId: ORG_ID },
    });

    expect(lastRequest().url).not.toMatch(/\/send$/);
  });

  it("posts the frozen event key and the metadata verbatim", async () => {
    await sendStaffEmail({
      eventType: PAYMENT_METHOD_REMOVED_EVENT_TYPE,
      orgId: ORG_ID,
      metadata: { cardsRemaining: "0" },
    });

    expect(JSON.parse(lastRequest().init.body as string)).toEqual({
      eventType: "payment_method_removed",
      metadata: { cardsRemaining: "0" },
    });
  });

  it("is bounded so a slow email service cannot hold a webhook open", async () => {
    await sendStaffEmail({
      eventType: PAYMENT_METHOD_REMOVED_EVENT_TYPE,
      orgId: ORG_ID,
      metadata: {},
    });

    expect(lastRequest().init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws on a non-2xx so the caller decides what to do with it", async () => {
    fetchMock.mockResolvedValueOnce(new Response("no template", { status: 500 }));

    await expect(
      sendStaffEmail({
        eventType: PAYMENT_METHOD_REMOVED_EVENT_TYPE,
        orgId: ORG_ID,
        metadata: {},
      })
    ).rejects.toThrow(/500/);
  });

  it("throws when the service is not configured", async () => {
    delete process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;

    await expect(
      sendStaffEmail({
        eventType: PAYMENT_METHOD_REMOVED_EVENT_TYPE,
        orgId: ORG_ID,
        metadata: {},
      })
    ).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("deployEmailTemplates", () => {
  it("upserts the template by name at boot", async () => {
    await deployEmailTemplates();

    const { url, init } = lastRequest();
    // Boot has no end user at all, so this is the user-less route too.
    expect(url).toBe("https://email.internal/platform-templates");
    expect(url).not.toMatch(/\/templates$/);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      templates: EMAIL_TEMPLATES,
    });
  });

  // Prod rejected the first registration with
  // `400 Missing required headers: x-org-id, x-user-id, and x-run-id`.
  // Boot registration is platform setup with no org, no user and no run, so it
  // sends the zero uuid the whole fleet uses on this endpoint.
  it("satisfies the identity headers /templates requires, with no tenant to name", async () => {
    await deployEmailTemplates();

    const headers = headersOfLastRequest();
    const zero = "00000000-0000-0000-0000-000000000000";
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["x-org-id"]).toBe(zero);
    expect(headers["x-user-id"]).toBe(zero);
    expect(headers["x-run-id"]).toBe(zero);
  });

  // The registration sentinel must never leak into a send: a send has a real
  // organisation, and a fabricated user id there is the #77 anti-pattern.
  it("never lets the registration sentinel reach a send", async () => {
    await sendStaffEmail({
      eventType: PAYMENT_METHOD_REMOVED_EVENT_TYPE,
      orgId: ORG_ID,
      metadata: {},
    });

    const headers = headersOfLastRequest();
    expect(headers).not.toHaveProperty("x-user-id");
    expect(headers["x-org-id"]).toBe(ORG_ID);
    expect(headers["x-run-id"]).not.toBe("00000000-0000-0000-0000-000000000000");
  });

  it("never throws when the email service rejects the registration", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    await expect(deployEmailTemplates()).resolves.toBeUndefined();
  });

  it("never throws when the email service is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(deployEmailTemplates()).resolves.toBeUndefined();
  });

  it("never throws, and skips the call, when it is not configured", async () => {
    delete process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
    await expect(deployEmailTemplates()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
