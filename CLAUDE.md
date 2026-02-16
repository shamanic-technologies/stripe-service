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
- **src/lib/resolve-stripe-key.ts** — Resolves Stripe key from key-service via appId (required)
- **src/lib/runs-client.ts** — Vendored runs-service HTTP client
- **src/middleware/serviceAuth.ts** — X-API-Key authentication
- **src/routes/** — Express route handlers (health, payments, status, webhooks)
- **src/db/schema.ts** — Drizzle table definitions
- **scripts/generate-openapi.ts** — OpenAPI spec generator

## Key Patterns
- Zod schemas define all request/response types and auto-generate OpenAPI
- Never edit openapi.json manually — always regenerate
- **Dynamic Stripe keys**: `appId` is required on all requests. The Stripe key is always resolved from key-service (`GET /internal/app-keys/stripe/decrypt?appId=xxx`). There is no `STRIPE_SECRET_KEY` env var — this service serves multiple apps by design.
- Runs-service integration is BLOCKING: create run → process payment → record → add costs → complete run
- Webhooks use Stripe signature verification + idempotent inserts
- All tests use Vitest + Supertest with mocked Stripe SDK

## Environment Variables
- `STRIPE_SERVICE_DATABASE_URL` — Neon Postgres connection string
- `STRIPE_WEBHOOK_SECRET` — Stripe webhook signing secret
- `STRIPE_SERVICE_API_KEY` — Service-to-service auth key
- `KEY_SERVICE_URL` / `KEY_SERVICE_API_KEY` — Key service connection (for dynamic Stripe key resolution)
- `RUNS_SERVICE_URL` / `RUNS_SERVICE_API_KEY` — Runs service connection
- `PORT` — Server port (default 3011)
