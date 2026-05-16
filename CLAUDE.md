# Stripe Service

Thin Stripe wrapper. Mirrors a subset of Stripe API objects (customers, checkout
sessions, payment intents, billing portal sessions) under Stripe-native routes
and DB tables. Internal-only HTTP API consumed by other Distribute services
(billing-service, future subscription-service). The service has no business
knowledge of its callers — all reload/dedupe logic lives in clients.

## Commands
- `npm run dev` — Start dev server with nodemon
- `npm run build` — Compile TypeScript + generate OpenAPI spec
- `npm test` — Run all tests
- `npm run test:unit` — Unit tests only
- `npm run test:integration` — Integration tests only
- `npm run db:generate` — Generate Drizzle migrations
- `npm run db:push` — Push schema to database

## Architecture
- **src/schemas.ts** — Zod schemas + OpenAPI path registration (single source of truth)
- **src/middleware/serviceAuth.ts** — X-API-Key authentication
- **src/middleware/identityHeaders.ts** — Requires x-org-id + x-user-id; logs optional context headers
- **src/middleware/callLog.ts** — Appends to api_call_log on every authenticated request
- **src/lib/stripe-client.ts** — Per-org Stripe SDK factory + webhook verifier
- **src/lib/key-client.ts** — Key-service HTTP client
- **src/lib/resolve-stripe-key.ts** — Resolves Stripe key from key-service via orgId + userId
- **src/lib/request-context.ts** — Builds per-request Stripe client + identity context
- **src/lib/event-processor.ts** — Idempotent event ingestion + Stripe-shape table upserts (shared by webhook handler and event-poller)
- **src/lib/event-poller.ts** — 5-min background poll of `GET /v1/events` from Stripe (webhook-loss recovery)
- **src/lib/historical-backfill.ts** — Boot-time full-history back-fill of every mirrored table (customers, payment_intents, checkout_sessions, customer_balance_transactions) via Stripe object-list APIs (events.list useless beyond 30-day retention)
- **src/routes/** — `customers.ts`, `checkout-sessions.ts`, `payment-intents.ts`, `billing-portal-sessions.ts`, `public-stats.ts`, `webhooks.ts`, `health.ts`
- **src/db/schema.ts** — Drizzle table definitions (Stripe-shape mirror)
- **scripts/generate-openapi.ts** — OpenAPI spec generator

## Routes

`/v1/*` = auth'd (X-API-Key + identity headers). `/public/*` = no auth, cross-org. `/health`, `/openapi.json` = public utility.

```
POST  /v1/customers                       — create
GET   /v1/customers/:id                   — retrieve (DB-first, Stripe fallback)
POST  /v1/customers/:id                   — update
GET   /v1/customers                       — list (DB-only)
POST  /v1/checkout/sessions               — create
GET   /v1/checkout/sessions/:id           — retrieve (DB-first, Stripe fallback)
GET   /v1/checkout/sessions               — list (DB-only)
POST  /v1/payment_intents                 — create
GET   /v1/payment_intents/:id             — retrieve (DB-first, Stripe fallback)
GET   /v1/payment_intents                 — list (DB-only) — used by callers to check in-flight reloads
POST  /v1/billing_portal/sessions         — create (no DB persistence; single-use URL)
POST  /v1/webhooks                        — Stripe webhook handler (signature-verified)
GET   /public/stats/billing               — cross-org aggregate Stripe stats (no auth)
```

## Key patterns

- **Stripe-shape passthrough.** Request bodies are validated with `.passthrough()` Zod schemas and forwarded verbatim to the Stripe SDK. Responses are the unmodified Stripe object. No custom request/response naming. **If a Stripe object does NOT have a corresponding Stripe API endpoint, do NOT invent a convenience wrapper here** — direct the caller to read the field off the parent Stripe-API endpoint we already mirror (e.g. `customer.balance` and `customer.invoice_settings.default_payment_method` read from `GET /v1/customers/:id`, not from `/v1/customers/balance` or `/v1/customers/has-payment-method`). Convenience flatteners with snake_case wrappers (`balance_cents` as string, flattened status enums, etc.) violate this rule.
- **1:1 org ↔ Stripe customer.** Each org has exactly one Stripe customer. Org-implicit reads (e.g. `GET /v1/balance_transactions`) resolve `customers WHERE org_id = $1 ORDER BY created_stripe DESC LIMIT 1`; 404 if no customer. Callers (billing-service) do NOT store `cus_xxx` — stripe-service is the source of truth for the mapping.
- **Public routes.** `/public/*` bypasses `serviceAuth` and `requireIdentityHeaders` middleware. Reserved for cross-org domain aggregates (stats, status pages). Not for Stripe-shape endpoints — those live under `/v1/`. Adding a new `/public/*` route is a deliberate architectural choice; reject the request unless the data is genuinely cross-org and non-sensitive.
- **org_id stamping.** On every `POST /v1/{customers,checkout/sessions,payment_intents}`, stripe-service stamps `metadata.org_id = <x-org-id>` so webhook events route back to the right tenant via `event.data.object.metadata.org_id`.
- **Webhook + 5-min poll sync.** Webhooks are primary. A background `setInterval(5min)` pulls Stripe `events.list` since the cursor stored in `event_sync_cursor` and processes any missed events. Both paths share `processEvent()` which is idempotent via `ON CONFLICT DO NOTHING` on `events.id`.
- **Boot-time historical back-fill.** On every boot, `backfillHistorical()` runs as a fire-and-forget background task fired right after `app.listen()`. Iterates `customers.list`, `paymentIntents.list`, and `checkout.sessions.list` globally. Routes each object to its tenant via `metadata.org_id`, then falls back to the local `customers` mirror's `org_id` for PaymentIntents and CheckoutSessions whose own metadata lacks `org_id` (PIs created via Checkout sessions don't inherit the session's metadata, so the customer lookup is the only recoverable source). Same `resolveOrgId(metadataOrgId, customerId)` helper in `event-processor.ts` is used by webhook + poll-driven upserts so the bug class cannot recur. Only stamps `"unknown"` when both sources are empty. Idempotent via `ON CONFLICT DO UPDATE` so re-runs refresh `raw_json` / status. Failure is logged via `console.error` but does NOT crash the service — the port is bound first so callers never get ECONNREFUSED during the back-fill window. Recovers Feb→Apr 2026 history that the 30-day events.list cursor cannot reach.
- **`customer.balance` is polluted — stripped on write.** Pre-#104 (billing-service), every usage tick wrote a `usage_applied` CBT into Stripe via `stripe.customers.createBalanceTransaction(...)`. Stripe's `customer.balance` is the running sum of those CBTs plus real top-up credits, so it no longer represents a pure prepaid balance for any org with pre-#104 history. `upsertCustomer()` strips `raw_json.balance` before persisting; no stripe-service response, mirror table, or back-fill exposes the field. Downstream consumers must compute credit balance from `payment_intents.amount_received` + their own promo ledger, NOT from `customer.balance`.
- **No `customer_balance_transactions` exposure.** Mirror table + `GET /v1/balance_transactions` route + webhook handler for `customer_balance_transaction.*` events are all removed. Same legacy-pollution rationale: individual CBTs cannot be cleanly partitioned into "real credit" vs "legacy usage_applied" without unreliable type heuristics. Drop the surface entirely. If a downstream service needs credit history, source it from its own ledger.
- **No service-side reload dedupe.** Stripe-service has no in-flight lock, no customer-scope coalesce, no gap-fill logic. Clients (billing-service) inspect in-flight PaymentIntents via `GET /v1/payment_intents?customer=cus_X` and own the business logic for "don't trigger reload too often".
- **Idempotency-Key forwarding.** If the caller sends an `Idempotency-Key` header, it's forwarded verbatim to the Stripe SDK call. Otherwise the SDK is called without one.
- **Reads.** Single-object GET = DB-first + Stripe fallback when row missing. List = DB-only (no live Stripe fetch). Webhook + poll keep DB fresh.
- **Auth.** `X-API-Key` mandatory on all non-webhook, non-public routes. `x-org-id` + `x-user-id` mandatory because Stripe key resolution is per-org. `x-brand-id`, `x-campaign-id`, `x-workflow-slug` optional — logged to `api_call_log` when present.
- **Multi-tenant Stripe key.** `resolveStripeKey(orgId, userId)` calls key-service `GET /keys/stripe/decrypt`. Per-request Stripe client (`makeStripeClient(key)`), no shared SDK instance.

## DB tables

```
customers                       — id (cus_…)   PK, org_id, email, name, metadata, raw_json, synced_at
checkout_sessions               — id (cs_…)    PK, org_id, customer, payment_intent, mode, status, raw_json, synced_at
payment_intents                 — id (pi_…)    PK, org_id, customer, amount, status, raw_json, synced_at
events                          — id (evt_…)   PK, type, object_id, payload, source ('webhook'|'poll'), received_at
event_sync_cursor               — id=1, last_event_id, last_synced_at  (single-row)
api_call_log                    — request audit: method, path, status, identity headers, stripe_object_id, duration_ms
```

`raw_json` holds the unmodified Stripe object — `GET /v1/{obj}/:id` returns this directly so the response shape matches Stripe verbatim. Exception: `customers.raw_json.balance` is stripped on every write (see "Polluted `customer.balance`" key pattern).

## Environment variables
- `STRIPE_SERVICE_DATABASE_URL` — Neon Postgres connection string
- `STRIPE_SERVICE_API_KEY` — Service-to-service auth key
- `KEY_SERVICE_URL` / `KEY_SERVICE_API_KEY` — Key service connection. Resolves three Stripe-related keys at runtime via key-service: per-org Stripe keys (`/keys/stripe/decrypt`), the platform Stripe key for the event poller (`/keys/platform/stripe/decrypt`), and the Stripe webhook signing secret (`/keys/platform/stripe-webhook/decrypt`). No Stripe secret is ever stored in env vars on this service.
- `RUN_EVENT_POLLER` — set to `"false"` to disable the background poller (default: enabled)
- `PORT` — Server port (default 3011)

## Out of scope (Phase 2)

Products, prices, subscriptions, invoices, refunds, disputes (Stripe objects not currently used by Distribute callers). Push-style webhook fan-out to downstream services. Reload-specific business endpoints (those live in billing-service). `customer.balance` and `customer_balance_transactions` (intentionally removed, see key patterns).
