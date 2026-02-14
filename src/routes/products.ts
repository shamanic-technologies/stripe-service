import { Router, Request, Response } from "express";
import {
  CreateProductRequestSchema,
  UpdateProductRequestSchema,
} from "../schemas";
import {
  createProduct,
  listProducts,
  getProduct,
  updateProduct,
} from "../lib/stripe-client";

const router = Router();

// POST /products
router.post("/products", async (req: Request, res: Response) => {
  const parsed = CreateProductRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  try {
    const product = await createProduct(parsed.data);
    return res.json(product);
  } catch (error: any) {
    console.error("Create product error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// GET /products
router.get("/products", async (req: Request, res: Response) => {
  try {
    const active = req.query.active === "true" ? true : req.query.active === "false" ? false : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const result = await listProducts({ active, limit });
    return res.json({ products: result.data, hasMore: result.has_more });
  } catch (error: any) {
    console.error("List products error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// GET /products/:id
router.get("/products/:id", async (req: Request, res: Response) => {
  try {
    const product = await getProduct(req.params.id);
    return res.json(product);
  } catch (error: any) {
    if (error.statusCode === 404 || error.code === "resource_missing") {
      return res.status(404).json({ error: "Product not found" });
    }
    console.error("Get product error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// PATCH /products/:id
router.patch("/products/:id", async (req: Request, res: Response) => {
  const parsed = UpdateProductRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  try {
    const product = await updateProduct(req.params.id, parsed.data);
    return res.json(product);
  } catch (error: any) {
    if (error.statusCode === 404 || error.code === "resource_missing") {
      return res.status(404).json({ error: "Product not found" });
    }
    console.error("Update product error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

export default router;
