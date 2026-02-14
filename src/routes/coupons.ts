import { Router, Request, Response } from "express";
import { CreateCouponRequestSchema } from "../schemas";
import { createCoupon, listCoupons, getCoupon, deleteCoupon } from "../lib/stripe-client";

const router = Router();

// POST /coupons
router.post("/coupons", async (req: Request, res: Response) => {
  const parsed = CreateCouponRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  try {
    const coupon = await createCoupon(parsed.data);
    return res.json(coupon);
  } catch (error: any) {
    console.error("Create coupon error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// GET /coupons
router.get("/coupons", async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const result = await listCoupons({ limit });
    return res.json({ coupons: result.data, hasMore: result.has_more });
  } catch (error: any) {
    console.error("List coupons error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// GET /coupons/:id
router.get("/coupons/:id", async (req: Request, res: Response) => {
  try {
    const coupon = await getCoupon(req.params.id);
    return res.json(coupon);
  } catch (error: any) {
    if (error.statusCode === 404 || error.code === "resource_missing") {
      return res.status(404).json({ error: "Coupon not found" });
    }
    console.error("Get coupon error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// DELETE /coupons/:id
router.delete("/coupons/:id", async (req: Request, res: Response) => {
  try {
    const result = await deleteCoupon(req.params.id);
    return res.json(result);
  } catch (error: any) {
    if (error.statusCode === 404 || error.code === "resource_missing") {
      return res.status(404).json({ error: "Coupon not found" });
    }
    console.error("Delete coupon error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

export default router;
