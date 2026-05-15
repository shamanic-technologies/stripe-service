import { Router, Request, Response, NextFunction } from "express";
import { eq, and, desc, lt } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../db";
import { customers, customerBalanceTransactions } from "../db/schema";
import { ListCustomerBalanceTransactionsQuerySchema } from "../schemas";
import { buildContext } from "../lib/request-context";
import { upsertCustomerBalanceTransaction } from "../lib/event-processor";

const router = Router();

/**
 * Org-implicit list of customer balance transactions.
 *
 * Assumes 1:1 between org and Stripe customer. Resolves the org's customer
 * server-side from x-org-id, then mirrors Stripe's list shape. Returns 404
 * when the org has no Stripe customer yet.
 */
router.get(
  "/v1/balance_transactions",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = ListCustomerBalanceTransactionsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid query", details: parsed.error.flatten() });
      }

      const orgId = res.locals.orgId as string;
      const { limit, starting_after } = parsed.data;
      const effectiveLimit = limit ?? 10;

      const customerRows = await db
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.orgId, orgId))
        .orderBy(desc(customers.createdStripe))
        .limit(1);

      if (customerRows.length === 0) {
        return res.status(404).json({ error: "Org has no Stripe customer" });
      }

      const customerId = customerRows[0].id;
      res.locals.stripeObjectId = customerId;

      const filters = [
        eq(customerBalanceTransactions.orgId, orgId),
        eq(customerBalanceTransactions.customer, customerId),
      ];
      if (starting_after) {
        const anchor = await db
          .select({ syncedAt: customerBalanceTransactions.syncedAt })
          .from(customerBalanceTransactions)
          .where(eq(customerBalanceTransactions.id, starting_after))
          .limit(1);
        if (anchor.length > 0) {
          filters.push(lt(customerBalanceTransactions.syncedAt, anchor[0].syncedAt));
        }
      }

      const rows = await db
        .select()
        .from(customerBalanceTransactions)
        .where(and(...filters))
        .orderBy(desc(customerBalanceTransactions.syncedAt))
        .limit(effectiveLimit + 1);

      const url = "/v1/balance_transactions";

      if (rows.length > 0) {
        const hasMore = rows.length > effectiveLimit;
        const data = rows.slice(0, effectiveLimit).map((r) => r.rawJson);
        return res.json({ object: "list", data, has_more: hasMore, url });
      }

      const ctx = await buildContext(req, res);
      const stripeList = await ctx.stripe.customers.listBalanceTransactions(customerId, {
        limit: effectiveLimit,
        ...(starting_after ? { starting_after } : {}),
      });

      for (const item of stripeList.data) {
        await upsertCustomerBalanceTransaction(
          item as Stripe.CustomerBalanceTransaction,
          orgId
        );
      }

      return res.json({
        object: "list",
        data: stripeList.data,
        has_more: stripeList.has_more,
        url,
      });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
