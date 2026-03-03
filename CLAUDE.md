# Stripe Service

Payment processing service using Stripe. Handles checkout sessions, payment intents, webhook processing, and integrates with runs-service for cost tracking.

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
- **src/lib/stripe-client.ts** — Stripe SDK wrapper (supports per-request keys)
- **src/lib/key-client.ts** — Key-service HTTP client for dynamic Stripe key resolution
- **src/lib/resolve-stripe-key.ts** — Resolves Stripe key from key-service via orgId + userId
- **src/lib/runs-client.ts** — Vendored runs-service HTTP client
- **src/middleware/serviceAuth.ts** — X-API-Key authentication
- **src/middleware/identityHeaders.ts** — Requires x-org-id and x-user-id headers
- **src/routes/** — Express route handlers (health, payments, status, webhooks)
- **src/db/schema.ts** — Drizzle table definitions
- **scripts/generate-openapi.ts** — OpenAPI spec generator

## Key Patterns
- Zod schemas define all request/response types and auto-generate OpenAPI
- Never edit openapi.json manually — always regenerate
- **Identity headers**: All endpoints (except /health, /openapi.json, webhooks) require `x-org-id` and `x-user-id` headers (internal UUIDs from client-service)
- **Dynamic Stripe keys**: The Stripe key is resolved from key-service via `GET /keys/stripe/decrypt?orgId=...&userId=...`. Returns `{ key, keySource }`. No `appId` — identity comes from headers.
- **Cost tracking**: `costSource` ("platform" or "org") is required on every runs-service cost item. Comes from key-service's decrypt response.
- Runs-service integration is BLOCKING: create run → process payment → record → add costs (with costSource) → complete run
- Webhooks use Stripe signature verification + idempotent inserts
- All tests use Vitest + Supertest with mocked Stripe SDK

## Environment Variables
- `STRIPE_SERVICE_DATABASE_URL` — Neon Postgres connection string
- `STRIPE_WEBHOOK_SECRET` — Stripe webhook signing secret
- `STRIPE_SERVICE_API_KEY` — Service-to-service auth key
- `KEY_SERVICE_URL` / `KEY_SERVICE_API_KEY` — Key service connection (for dynamic Stripe key resolution)
- `RUNS_SERVICE_URL` / `RUNS_SERVICE_API_KEY` — Runs service connection
- `PORT` — Server port (default 3011)
