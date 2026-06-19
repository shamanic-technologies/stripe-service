import { Router, Request, Response, NextFunction } from "express";
import { eq, and, desc, lt, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../db";
import { customers } from "../db/schema";
import {
  CreateCustomerRequestSchema,
  UpdateCustomerRequestSchema,
  ListCustomersQuerySchema,
} from "../schemas";
import { buildContext, stripeRequestOptions } from "../lib/request-context";
import { recordApiSnapshot } from "../lib/event-processor";
import { isResourceMissing } from "../lib/stripe-client";
import { getUserById, joinName } from "../lib/client-service-client";

const router = Router();

/**
 * Resolve the authenticated user's email + name from client-service so the
 * Stripe customer is born with an email. Returns `{}` when none is available
 * (user not on record, or no email/name set) — not a failure, see
 * client-service-client. Infra failures propagate (fail loud).
 */
async function resolveIdentityFields(
  userId: string
): Promise<{ email?: string; name?: string }> {
  const identity = await getUserById(userId);
  if (!identity) return {};
  const out: { email?: string; name?: string } = {};
  if (identity.email) out.email = identity.email;
  const name = joinName(identity);
  if (name) out.name = name;
  return out;
}

router.post("/v1/customers", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = CreateCustomerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const ctx = await buildContext(req, res);
    const body = parsed.data as Stripe.CustomerCreateParams;

    // Idempotent per org: 1:1 org<->customer is the invariant. If the org
    // already has a mirrored customer, return it instead of creating a duplicate
    // Stripe customer (callers re-issue create on retries / parallel setup paths).
    const existingRows = await db
      .select()
      .from(customers)
      .where(eq(customers.orgId, ctx.orgId))
      .orderBy(desc(customers.syncedAt))
      .limit(1);

    if (existingRows.length > 0 && existingRows[0].rawJson) {
      const existing = existingRows[0].rawJson as Stripe.Customer;
      res.locals.stripeObjectId = existing.id;

      // Backfill: most existing customers were created with no email (callers
      // POSTed an empty body). If the mirrored customer lacks one, resolve it
      // now and patch the Stripe customer so the email is attached going forward.
      if (!existing.email) {
        const fields = await resolveIdentityFields(ctx.userId);
        const patch: Stripe.CustomerUpdateParams = {};
        if (fields.email) patch.email = fields.email;
        if (fields.name && !existing.name) patch.name = fields.name;
        if (patch.email || patch.name) {
          const updated = await ctx.stripe.customers.update(
            existing.id,
            patch,
            stripeRequestOptions(ctx)
          );
          await recordApiSnapshot(updated, "customer", ctx.orgId);
          return res.json(updated);
        }
      }

      return res.json(existing);
    }

    // Stamp org_id into Stripe customer metadata so webhooks can route back.
    const metadata = { ...(body.metadata ?? {}), org_id: ctx.orgId };

    // Attach the authenticated user's email (+ name) when the caller didn't
    // supply an email — the common case (billing-service POSTs an empty body).
    // Caller-supplied values always win (passthrough preserved). Gated on a
    // missing email so callers that already have one skip the client-service hop.
    const createParams: Stripe.CustomerCreateParams = { ...body, metadata };
    if (!createParams.email) {
      const fields = await resolveIdentityFields(ctx.userId);
      if (fields.email) createParams.email = fields.email;
      if (!createParams.name && fields.name) createParams.name = fields.name;
    }

    const customer = await ctx.stripe.customers.create(
      createParams,
      stripeRequestOptions(ctx)
    );

    res.locals.stripeObjectId = customer.id;
    await recordApiSnapshot(customer, "customer", ctx.orgId);
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
      await recordApiSnapshot(customer as Stripe.Customer, "customer", orgId);
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

    await recordApiSnapshot(customer, "customer", ctx.orgId);
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
    const { email, limit, starting_after, metadata } = parsed.data;
    const effectiveLimit = limit ?? 10;

    const filters = [eq(customers.orgId, orgId)];
    if (email) filters.push(eq(customers.email, email));
    if (metadata) {
      for (const [key, value] of Object.entries(metadata)) {
        filters.push(sql`${customers.metadata}->>${key} = ${value}`);
      }
    }
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
