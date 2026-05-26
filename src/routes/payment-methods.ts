import { Router, Request, Response, NextFunction } from "express";
import { eq, and } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../db";
import { customers } from "../db/schema";
import { ListPaymentMethodsQuerySchema } from "../schemas";
import { buildContext } from "../lib/request-context";

const router = Router();

router.get(
  "/v1/payment_methods",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = ListPaymentMethodsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid query", details: parsed.error.flatten() });
      }
      const orgId = res.locals.orgId as string;
      const { customer, type } = parsed.data;

      // Enforce 1:1 org -> customer mapping by requiring the customer to
      // exist in this org's mirror. Prevents cross-org PM enumeration via
      // guessed cus_xxx IDs.
      const row = await db
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.id, customer), eq(customers.orgId, orgId)))
        .limit(1);

      if (row.length === 0) {
        return res.status(404).json({ error: "Customer not found" });
      }

      res.locals.stripeObjectId = customer;
      const ctx = await buildContext(req, res);
      const params: Stripe.PaymentMethodListParams = { customer };
      if (type) params.type = type as Stripe.PaymentMethodListParams.Type;
      const list = await ctx.stripe.paymentMethods.list(params);
      return res.json(list);
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
