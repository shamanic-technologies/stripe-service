import { Router, Request, Response } from "express";
import { CreatePriceRequestSchema } from "../schemas";
import { createPrice, listPrices, getPrice } from "../lib/stripe-client";

const router = Router();

// POST /prices
router.post("/prices", async (req: Request, res: Response) => {
  const parsed = CreatePriceRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  try {
    const price = await createPrice(parsed.data);
    return res.json(price);
  } catch (error: any) {
    console.error("Create price error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// GET /prices
router.get("/prices", async (req: Request, res: Response) => {
  try {
    const product = req.query.product as string | undefined;
    const active = req.query.active === "true" ? true : req.query.active === "false" ? false : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const result = await listPrices({ product, active, limit });
    return res.json({ prices: result.data, hasMore: result.has_more });
  } catch (error: any) {
    console.error("List prices error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// GET /prices/:id
router.get("/prices/:id", async (req: Request, res: Response) => {
  try {
    const price = await getPrice(req.params.id);
    return res.json(price);
  } catch (error: any) {
    if (error.statusCode === 404 || error.code === "resource_missing") {
      return res.status(404).json({ error: "Price not found" });
    }
    console.error("Get price error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

export default router;
