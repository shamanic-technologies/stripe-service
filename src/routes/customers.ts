import { Router, Request, Response, NextFunction } from "express";
import { eq, and, desc, lt } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../db";
import { customers } from "../db/schema";
import {
  CreateCustomerRequestSchema,
  UpdateCustomerRequestSchema,
  ListCustomersQuerySchema,
} from "../schemas";
import { buildContext, stripeRequestOptions } from "../lib/request-context";
import { upsertCustomer } from "../lib/event-processor";
import { isResourceMissing } from "../lib/stripe-client";

const router = Router();

router.post("/v1/customers", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = CreateCustomerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const ctx = await buildContext(req, res);
    const body = parsed.data as Stripe.CustomerCreateParams;

    // Stamp org_id into Stripe customer metadata so webhooks can route back.
    const metadata = { ...(body.metadata ?? {}), org_id: ctx.orgId };

    const customer = await ctx.stripe.customers.create(
      { ...body, metadata },
      stripeRequestOptions(ctx)
    );

    res.locals.stripeObjectId = customer.id;
    await upsertCustomer(customer, ctx.orgId);
    return res.json(customer);
  } catch (err) {
    return next(err);
  }
});

router.get("/v1/customers/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = res.locals.orgId as string;
    const { id } = req.params;
    res.locals.stripeObjectId = id;

    const row = await db
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.orgId, orgId)))
      .limit(1);

    if (row.length > 0 && row[0].rawJson) {
      return res.json(row[0].rawJson);
    }

    const ctx = await buildContext(req, res);
    try {
      const customer = await ctx.stripe.customers.retrieve(id);
      if ((customer as Stripe.DeletedCustomer).deleted) {
        return res.status(404).json({ error: "Customer deleted" });
      }
      await upsertCustomer(customer as Stripe.Customer, orgId);
      return res.json(customer);
    } catch (err) {
      if (isResourceMissing(err)) {
        return res.status(404).json({ error: "Customer not found" });
      }
      throw err;
    }
  } catch (err) {
    return next(err);
  }
});

router.post("/v1/customers/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = UpdateCustomerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const ctx = await buildContext(req, res);
    const { id } = req.params;
    res.locals.stripeObjectId = id;

    const customer = await ctx.stripe.customers.update(
      id,
      parsed.data as Stripe.CustomerUpdateParams,
      stripeRequestOptions(ctx)
    );

    await upsertCustomer(customer, ctx.orgId);
    return res.json(customer);
  } catch (err) {
    if (isResourceMissing(err)) {
      return res.status(404).json({ error: "Customer not found" });
    }
    return next(err);
  }
});

router.get("/v1/customers", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = ListCustomersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    }
    const orgId = res.locals.orgId as string;
    const { email, limit, starting_after } = parsed.data;
    const effectiveLimit = limit ?? 10;

    const filters = [eq(customers.orgId, orgId)];
    if (email) filters.push(eq(customers.email, email));
    if (starting_after) {
      const anchor = await db
        .select({ syncedAt: customers.syncedAt })
        .from(customers)
        .where(eq(customers.id, starting_after))
        .limit(1);
      if (anchor.length > 0) {
        filters.push(lt(customers.syncedAt, anchor[0].syncedAt));
      }
    }

    const rows = await db
      .select()
      .from(customers)
      .where(and(...filters))
      .orderBy(desc(customers.syncedAt))
      .limit(effectiveLimit + 1);

    const hasMore = rows.length > effectiveLimit;
    const data = rows.slice(0, effectiveLimit).map((r) => r.rawJson);

    return res.json({
      object: "list",
      data,
      has_more: hasMore,
      url: "/v1/customers",
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
