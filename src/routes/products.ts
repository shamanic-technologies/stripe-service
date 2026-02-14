import { Router, Request, Response } from "express";
import {
  CreateProductRequestSchema,
  CreatePriceRequestSchema,
  CreateCouponRequestSchema,
} from "../schemas";
import { createProduct, createPrice, createCoupon } from "../lib/stripe-client";

const router = Router();

// POST /products/create
router.post("/products/create", async (req: Request, res: Response) => {
  const parsed = CreateProductRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const data = parsed.data;

  try {
    const result = await createProduct({
      name: data.name,
      description: data.description,
      metadata: data.metadata,
    });

    if (!result.success) {
      return res.status(500).json({ error: result.error || "Stripe error" });
    }

    return res.json({
      success: true,
      productId: result.productId,
      name: result.name,
    });
  } catch (error: any) {
    console.error("Product create error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
});

// POST /prices/create
router.post("/prices/create", async (req: Request, res: Response) => {
  const parsed = CreatePriceRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const data = parsed.data;

  try {
    const result = await createPrice({
      productId: data.productId,
      unitAmountInCents: data.unitAmountInCents,
      currency: data.currency,
      recurring: data.recurring
        ? {
            interval: data.recurring.interval,
            intervalCount: data.recurring.intervalCount,
          }
        : undefined,
      metadata: data.metadata,
    });

    if (!result.success) {
      return res.status(500).json({ error: result.error || "Stripe error" });
    }

    return res.json({
      success: true,
      priceId: result.priceId,
      productId: result.productId,
      unitAmountInCents: result.unitAmountInCents,
      currency: result.currency,
    });
  } catch (error: any) {
    console.error("Price create error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
});

// POST /coupons/create
router.post("/coupons/create", async (req: Request, res: Response) => {
  const parsed = CreateCouponRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const data = parsed.data;

  try {
    const result = await createCoupon({
      name: data.name,
      percentOff: data.percentOff,
      amountOffInCents: data.amountOffInCents,
      currency: data.currency,
      duration: data.duration,
      durationInMonths: data.durationInMonths,
      maxRedemptions: data.maxRedemptions,
      redeemBy: data.redeemBy
        ? Math.floor(new Date(data.redeemBy).getTime() / 1000)
        : undefined,
      metadata: data.metadata,
    });

    if (!result.success) {
      return res.status(500).json({ error: result.error || "Stripe error" });
    }

    return res.json({
      success: true,
      couponId: result.couponId,
      name: result.name,
      percentOff: result.percentOff,
      amountOffInCents: result.amountOffInCents,
      currency: result.currency,
      duration: result.duration,
    });
  } catch (error: any) {
    console.error("Coupon create error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Internal server error" });
  }
});

export default router;
