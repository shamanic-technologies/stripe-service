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
- **src/routes/** — `customers.ts`, `checkout-sessions.ts`, `payment-intents.ts`, `billing-portal-sessions.ts`, `webhooks.ts`, `health.ts`
- **src/db/schema.ts** — Drizzle table definitions (Stripe-shape mirror)
- **scripts/generate-openapi.ts** — OpenAPI spec generator

## Routes (v1)

All under `/v1/` except `/health` and `/openapi.json`.

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
```

## Key patterns

- **Stripe-shape passthrough.** Request bodies are validated with `.passthrough()` Zod schemas and forwarded verbatim to the Stripe SDK. Responses are the unmodified Stripe object. No custom request/response naming.
- **org_id stamping.** On every `POST /v1/{customers,checkout/sessions,payment_intents}`, stripe-service stamps `metadata.org_id = <x-org-id>` so webhook events route back to the right tenant via `event.data.object.metadata.org_id`.
- **Webhook + 5-min poll sync.** Webhooks are primary. A background `setInterval(5min)` pulls Stripe `events.list` since the cursor stored in `event_sync_cursor` and processes any missed events. Both paths share `processEvent()` which is idempotent via `ON CONFLICT DO NOTHING` on `events.id`.
- **No service-side reload dedupe.** Stripe-service has no in-flight lock, no customer-scope coalesce, no gap-fill logic. Clients (billing-service) inspect in-flight PaymentIntents via `GET /v1/payment_intents?customer=cus_X` and own the business logic for "don't trigger reload too often".
- **Idempotency-Key forwarding.** If the caller sends an `Idempotency-Key` header, it's forwarded verbatim to the Stripe SDK call. Otherwise the SDK is called without one.
- **Reads.** Single-object GET = DB-first + Stripe fallback when row missing. List = DB-only (no live Stripe fetch). Webhook + poll keep DB fresh.
- **Auth.** `X-API-Key` mandatory on all non-webhook, non-public routes. `x-org-id` + `x-user-id` mandatory because Stripe key resolution is per-org. `x-brand-id`, `x-campaign-id`, `x-workflow-slug` optional — logged to `api_call_log` when present.
- **Multi-tenant Stripe key.** `resolveStripeKey(orgId, userId)` calls key-service `GET /keys/stripe/decrypt`. Per-request Stripe client (`makeStripeClient(key)`), no shared SDK instance.

## DB tables

```
customers          — id (cus_…) PK, org_id, email, name, metadata, raw_json, synced_at
checkout_sessions  — id (cs_…)  PK, org_id, customer, payment_intent, mode, status, raw_json, synced_at
payment_intents    — id (pi_…)  PK, org_id, customer, amount, status, raw_json, synced_at
events             — id (evt_…) PK, type, object_id, payload, source ('webhook'|'poll'), received_at
event_sync_cursor  — id=1, last_event_id, last_synced_at  (single-row)
api_call_log       — request audit: method, path, status, identity headers, stripe_object_id, duration_ms
```

`raw_json` holds the unmodified Stripe object — `GET /v1/{obj}/:id` returns this directly so the response shape matches Stripe verbatim.

## Environment variables
- `STRIPE_SERVICE_DATABASE_URL` — Neon Postgres connection string
- `STRIPE_SERVICE_API_KEY` — Service-to-service auth key
- `STRIPE_WEBHOOK_SECRET` — Stripe webhook signing secret
- `KEY_SERVICE_URL` / `KEY_SERVICE_API_KEY` — Key service connection (per-org Stripe keys + platform Stripe key for event poller)
- `RUN_EVENT_POLLER` — set to `"false"` to disable the background poller (default: enabled)
- `PORT` — Server port (default 3011)

## Out of scope (Phase 2)

Products, prices, subscriptions, invoices, refunds, disputes (Stripe objects not currently used by Distribute callers). Push-style webhook fan-out to downstream services. Reload-specific business endpoints (those live in billing-service).
