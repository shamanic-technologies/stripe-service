import * as dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { serviceAuth } from "./middleware/serviceAuth";
import { requireIdentityHeaders } from "./middleware/identityHeaders";
import { callLog } from "./middleware/callLog";
import { db } from "./db";
import healthRoutes from "./routes/health";
import customersRoutes from "./routes/customers";
import checkoutSessionsRoutes from "./routes/checkout-sessions";
import paymentIntentsRoutes from "./routes/payment-intents";
import paymentMethodsRoutes from "./routes/payment-methods";
import billingPortalSessionsRoutes from "./routes/billing-portal-sessions";
import publicStatsRoutes from "./routes/public-stats";
import webhooksRoutes from "./routes/webhooks";
import { startEventPoller } from "./lib/event-poller";
import { backfillHistorical } from "./lib/historical-backfill";

const app = express();
const PORT = process.env.PORT || 3011;

const allowedOrigins = [
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:3003",
  "https://app.pressbeat.io",
  "https://admin.pressbeat.io",
  "https://dashboard.mcpfactory.org",
  "https://mcpfactory.org",
  process.env.ALLOWED_ORIGIN,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1) callback(null, true);
      else callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-API-Key",
      "X-Org-Id",
      "X-User-Id",
      "X-Brand-Id",
      "X-Campaign-Id",
      "X-Workflow-Slug",
      "Idempotency-Key",
      "Stripe-Signature",
    ],
  })
);

// Raw body for Stripe webhook signature verification (must precede express.json)
app.use("/v1/webhooks", express.raw({ type: "application/json" }));

app.use(express.json());
app.use(serviceAuth);
app.use(requireIdentityHeaders);
app.use(callLog);

app.get("/openapi.json", (_req, res) => {
  const specPath = path.resolve(__dirname, "../openapi.json");
  if (fs.existsSync(specPath)) {
    const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
    res.json(spec);
  } else {
    res.status(404).json({ error: "OpenAPI spec not generated. Run: npm run generate:openapi" });
  }
});

app.use("/", healthRoutes);
app.use("/", customersRoutes);
app.use("/", checkoutSessionsRoutes);
app.use("/", paymentIntentsRoutes);
app.use("/", paymentMethodsRoutes);
app.use("/", billingPortalSessionsRoutes);
app.use("/", publicStatsRoutes);
app.use("/", webhooksRoutes);

if (process.env.NODE_ENV !== "test") {
  migrate(db, { migrationsFolder: "./drizzle" })
    .then(() => {
      console.log("[stripe-service] Migrations complete");
      app.listen(Number(PORT), "::", () => {
        console.log(`[stripe-service] Service running on port ${PORT}`);
        startEventPoller();
        // Fire-and-forget historical back-fill. Runs after the port is bound
        // so Railway never sees a long boot window during which callers get
        // ECONNREFUSED. Idempotent via `ON CONFLICT DO UPDATE`, so failures
        // are recovered on the next boot.
        backfillHistorical().catch((err) => {
          console.error("[stripe-service] Historical back-fill failed:", err);
        });
      });
    })
    .catch((err) => {
      console.error("[stripe-service] Migration failed:", err);
      process.exit(1);
    });
}

export default app;
