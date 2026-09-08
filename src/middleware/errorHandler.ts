import type { NextFunction, Request, Response } from "express";
import { RevolutApiError } from "../lib/revolut-client";

/**
 * The last word on every request that threw.
 *
 * Without it Express's default handler answers, and it answers badly in two
 * ways at once. It reads `err.status`/`err.statusCode` off whatever was thrown
 * — and a vendor SDK error carries the VENDOR's status, so an acquirer saying
 * `400 No such customer` came back to our caller as a 400, telling it that ITS
 * request was malformed when the request was fine. And the body is Express's
 * HTML page containing the stack, which states container file paths and cannot
 * be acted on by a service-to-service caller.
 *
 * So: a vendor status is never reflected. An error that reaches here means we
 * could not answer the question, which is a 5xx by the contract every internal
 * read in this service documents — 502 when the acquirer is what failed us
 * (we could not ASK), 500 otherwise. Routes that know better answer for
 * themselves before it gets here; a definitive acquirer answer is classified at
 * the call site (see `saved-method.ts`), never here.
 *
 * The message's FIRST LINE rides along because a caller has to be able to act on
 * it, and these routes are `x-api-key`-only server-to-server. The STACK never
 * does — including when an error carries its own stack inside `message`.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  // FIRST LINE only. Some errors carry their own stack inside the message
  // (undici's socket errors do), so forwarding `message` whole re-introduces
  // exactly the file paths this handler exists to keep out of the response.
  const message = (err instanceof Error ? err.message : String(err)).split("\n")[0].trim();
  const fromAcquirer =
    err instanceof RevolutApiError ||
    (typeof (err as { type?: unknown })?.type === "string" &&
      /^Stripe/.test((err as { type: string }).type));

  console.error("[stripe-service] Unhandled error:", err);

  res.status(fromAcquirer ? 502 : 500).json({
    error: message,
    ...(fromAcquirer ? { code: "acquirer_unavailable" } : {}),
  });
}
