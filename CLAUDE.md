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
- **src/lib/stripe-client.ts** — Stripe SDK wrapper
- **src/lib/runs-client.ts** — Vendored runs-service HTTP client
- **src/middleware/serviceAuth.ts** — X-API-Key authentication
- **src/routes/** — Express route handlers (health, payments, status, webhooks)
- **src/db/schema.ts** — Drizzle table definitions
- **scripts/generate-openapi.ts** — OpenAPI spec generator

## Key Patterns
- Zod schemas define all request/response types and auto-generate OpenAPI
- Never edit openapi.json manually — always regenerate
- Runs-service integration is BLOCKING: create run → process payment → record → add costs → complete run
- Webhooks use Stripe signature verification + idempotent inserts
- All tests use Vitest + Supertest with mocked Stripe SDK

## Environment Variables
- `STRIPE_SERVICE_DATABASE_URL` — Neon Postgres connection string
- `STRIPE_SECRET_KEY` — Stripe API secret key
- `STRIPE_WEBHOOK_SECRET` — Stripe webhook signing secret
- `STRIPE_SERVICE_API_KEY` — Service-to-service auth key
- `RUNS_SERVICE_URL` / `RUNS_SERVICE_API_KEY` — Runs service connection
- `PORT` — Server port (default 3011)
