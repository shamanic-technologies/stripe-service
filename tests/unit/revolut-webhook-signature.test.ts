import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  verifyRevolutSignature,
  orderIdFromWebhook,
} from "../../src/routes/revolut-webhooks";

const SECRET = "wsk_test_secret";
const BODY = JSON.stringify({ event: "ORDER_COMPLETED", order_id: "abc" });

function sign(body: string, ts: string, secret = SECRET) {
  return (
    "v1=" +
    crypto.createHmac("sha256", secret).update(`v1.${ts}.${body}`).digest("hex")
  );
}

describe("verifyRevolutSignature", () => {
  const now = 1_800_000_000;
  const ts = String(now);

  it("accepts a signature computed over the EXACT bytes Revolut sent", () => {
    expect(
      verifyRevolutSignature({
        rawBody: BODY,
        timestamp: ts,
        signatureHeader: sign(BODY, ts),
        secret: SECRET,
        nowSeconds: now,
      })
    ).toBe(true);
  });

  it("rejects a body that changed by even one byte", () => {
    expect(
      verifyRevolutSignature({
        rawBody: BODY + " ",
        timestamp: ts,
        signatureHeader: sign(BODY, ts),
        secret: SECRET,
        nowSeconds: now,
      })
    ).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    expect(
      verifyRevolutSignature({
        rawBody: BODY,
        timestamp: ts,
        signatureHeader: sign(BODY, ts, "wrong"),
        secret: SECRET,
        nowSeconds: now,
      })
    ).toBe(false);
  });

  it("rejects a replay outside the tolerance window", () => {
    expect(
      verifyRevolutSignature({
        rawBody: BODY,
        timestamp: ts,
        signatureHeader: sign(BODY, ts),
        secret: SECRET,
        nowSeconds: now + 3600,
      })
    ).toBe(false);
  });

  it("accepts a MILLISECOND timestamp, since the sender's unit is not ours to assume", () => {
    const msTs = String(now * 1000);
    expect(
      verifyRevolutSignature({
        rawBody: BODY,
        timestamp: msTs,
        signatureHeader: sign(BODY, msTs),
        secret: SECRET,
        nowSeconds: now,
      })
    ).toBe(true);
  });

  it("accepts when the header carries several versions and one matches", () => {
    expect(
      verifyRevolutSignature({
        rawBody: BODY,
        timestamp: ts,
        signatureHeader: `v0=deadbeef,${sign(BODY, ts)}`,
        secret: SECRET,
        nowSeconds: now,
      })
    ).toBe(true);
  });

  it("rejects a missing signature or timestamp instead of passing them through", () => {
    expect(
      verifyRevolutSignature({
        rawBody: BODY,
        timestamp: undefined,
        signatureHeader: sign(BODY, ts),
        secret: SECRET,
        nowSeconds: now,
      })
    ).toBe(false);
    expect(
      verifyRevolutSignature({
        rawBody: BODY,
        timestamp: ts,
        signatureHeader: undefined,
        secret: SECRET,
        nowSeconds: now,
      })
    ).toBe(false);
  });

  it("rejects a non-numeric timestamp rather than throwing", () => {
    expect(
      verifyRevolutSignature({
        rawBody: BODY,
        timestamp: "not-a-number",
        signatureHeader: sign(BODY, ts),
        secret: SECRET,
        nowSeconds: now,
      })
    ).toBe(false);
  });
});

describe("orderIdFromWebhook", () => {
  it("reads the order id under any of the names a delivery might use", () => {
    expect(orderIdFromWebhook({ order_id: "a" })).toBe("a");
    expect(orderIdFromWebhook({ orderId: "b" })).toBe("b");
    expect(orderIdFromWebhook({ id: "c" })).toBe("c");
  });

  it("returns null rather than guessing when there is no id", () => {
    expect(orderIdFromWebhook({ event: "SOMETHING" })).toBeNull();
    expect(orderIdFromWebhook(null)).toBeNull();
    expect(orderIdFromWebhook("string")).toBeNull();
  });
});
