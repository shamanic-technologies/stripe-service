import { messageOf } from "../lib/db-error.js";
import { Router, Request, Response, NextFunction } from "express";
import { NoChargeablePaymentMethod } from "../lib/charge-org";
import {
  CaptureExceedsHold,
  captureCardHold,
  cardHoldView,
  HoldAlreadyCaptured,
  HoldIdempotencyKeyReused,
  HoldNotFound,
  HoldNotLive,
  HoldPending,
  listCardHolds,
  liveHold,
  NoAcquirerCustomer,
  placeCardHold,
  releaseCardHold,
} from "../lib/card-holds";
import {
  CaptureCardHoldRequestSchema,
  PlaceCardHoldRequestSchema,
} from "../schemas";

/**
 * Card holds — `/internal/card_holds/by-org/:orgId…`. X-API-Key only, the org
 * keyed off the path, the acquirer resolved here. See src/lib/card-holds.ts.
 */
const router = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The answers that are not "we could not ask", each said in its own words. */
function knownRefusal(err: unknown, res: Response): Response | null {
  if (err instanceof NoChargeablePaymentMethod) {
    return res.status(409).json({ error: messageOf(err), code: "no_saved_payment_method" });
  }
  if (err instanceof NoAcquirerCustomer) {
    return res.status(404).json({ error: messageOf(err), code: "no_customer" });
  }
  if (err instanceof HoldIdempotencyKeyReused) {
    return res.status(409).json({
      error: messageOf(err),
      code: "idempotency_key_reused",
      existing: cardHoldView(err.existing),
    });
  }
  if (err instanceof HoldNotFound) {
    return res.status(404).json({ error: messageOf(err), code: "hold_not_found" });
  }
  if (err instanceof HoldNotLive) {
    return res.status(409).json({
      error: messageOf(err),
      code: "hold_not_live",
      hold: cardHoldView(err.hold),
    });
  }
  if (err instanceof HoldAlreadyCaptured) {
    return res.status(409).json({
      error: messageOf(err),
      code: "hold_already_captured",
      hold: cardHoldView(err.hold),
    });
  }
  if (err instanceof CaptureExceedsHold) {
    return res.status(400).json({ error: messageOf(err), code: "capture_exceeds_hold" });
  }
  if (err instanceof HoldPending) {
    res.setHeader("Retry-After", "30");
    return res.status(503).json({
      error: messageOf(err),
      code: "hold_pending",
      hold: cardHoldView(err.hold),
    });
  }
  return null;
}

router.post(
  "/internal/card_holds/by-org/:orgId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.orgId;
      res.locals.orgId = orgId;
      const parsed = PlaceCardHoldRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid request", details: parsed.error.flatten() });
      }
      const header = req.headers["idempotency-key"];
      const idempotencyKey = typeof header === "string" ? header.trim() : "";
      if (!idempotencyKey) {
        return res.status(400).json({
          error: "Idempotency-Key header is required (guarantees one hold per attempt on retry)",
        });
      }
      const placed = await placeCardHold({ orgId, ...parsed.data, idempotencyKey });
      res.locals.stripeObjectId = placed.hold.reference ?? undefined;
      return res.json(cardHoldView(placed.hold, { clientSecret: placed.clientSecret }));
    } catch (err) {
      return knownRefusal(err, res) ?? next(err);
    }
  }
);

router.get(
  "/internal/card_holds/by-org/:orgId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.orgId;
      res.locals.orgId = orgId;
      const now = new Date();
      const holds = await listCardHolds(orgId);
      const live = liveHold(holds, now);
      return res.json({
        object: "list",
        live_hold: live ? cardHoldView(live, {}, now) : null,
        data: holds.map((h) => cardHoldView(h, {}, now)),
        has_more: false,
      });
    } catch (err) {
      return next(err);
    }
  }
);

router.post(
  "/internal/card_holds/by-org/:orgId/:holdId/capture",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, holdId } = req.params;
      res.locals.orgId = orgId;
      if (!UUID_RE.test(holdId)) {
        return res.status(400).json({ error: "holdId must be a uuid" });
      }
      const parsed = CaptureCardHoldRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid request", details: parsed.error.flatten() });
      }
      const hold = await captureCardHold({ orgId, holdId, amount: parsed.data.amount });
      res.locals.stripeObjectId = hold.reference ?? undefined;
      return res.json(cardHoldView(hold));
    } catch (err) {
      return knownRefusal(err, res) ?? next(err);
    }
  }
);

router.post(
  "/internal/card_holds/by-org/:orgId/:holdId/release",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, holdId } = req.params;
      res.locals.orgId = orgId;
      if (!UUID_RE.test(holdId)) {
        return res.status(400).json({ error: "holdId must be a uuid" });
      }
      const hold = await releaseCardHold({ orgId, holdId });
      return res.json(cardHoldView(hold));
    } catch (err) {
      return knownRefusal(err, res) ?? next(err);
    }
  }
);

export default router;
