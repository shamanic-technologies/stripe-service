import { Router, Request, Response } from "express";
import {
  CreateCustomerRequestSchema,
  UpdateCustomerRequestSchema,
} from "../schemas";
import {
  createCustomer,
  listCustomers,
  getCustomer,
  updateCustomer,
} from "../lib/stripe-client";

const router = Router();

// POST /customers
router.post("/customers", async (req: Request, res: Response) => {
  const parsed = CreateCustomerRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  try {
    const customer = await createCustomer(parsed.data);
    return res.json(customer);
  } catch (error: any) {
    console.error("Create customer error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// GET /customers
router.get("/customers", async (req: Request, res: Response) => {
  try {
    const email = req.query.email as string | undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const result = await listCustomers({ email, limit });
    return res.json({ customers: result.data, hasMore: result.has_more });
  } catch (error: any) {
    console.error("List customers error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// GET /customers/:id
router.get("/customers/:id", async (req: Request, res: Response) => {
  try {
    const customer = await getCustomer(req.params.id);
    return res.json(customer);
  } catch (error: any) {
    if (error.statusCode === 404 || error.code === "resource_missing") {
      return res.status(404).json({ error: "Customer not found" });
    }
    console.error("Get customer error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// PATCH /customers/:id
router.patch("/customers/:id", async (req: Request, res: Response) => {
  const parsed = UpdateCustomerRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  try {
    const customer = await updateCustomer(req.params.id, parsed.data);
    return res.json(customer);
  } catch (error: any) {
    if (error.statusCode === 404 || error.code === "resource_missing") {
      return res.status(404).json({ error: "Customer not found" });
    }
    console.error("Update customer error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

export default router;
