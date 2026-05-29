import express from "express";
import cors from "cors";
import { serviceAuth } from "../../src/middleware/serviceAuth";
import { requireIdentityHeaders } from "../../src/middleware/identityHeaders";
import { callLog } from "../../src/middleware/callLog";
import healthRoutes from "../../src/routes/health";
import customersRoutes from "../../src/routes/customers";
import internalCustomersRoutes from "../../src/routes/internal-customers";
import checkoutSessionsRoutes from "../../src/routes/checkout-sessions";
import paymentIntentsRoutes from "../../src/routes/payment-intents";
import paymentMethodsRoutes from "../../src/routes/payment-methods";
import billingPortalSessionsRoutes from "../../src/routes/billing-portal-sessions";
import publicStatsRoutes from "../../src/routes/public-stats";
import webhooksRoutes from "../../src/routes/webhooks";

export function createTestApp() {
  const app = express();
  app.use(cors());
  app.use("/v1/webhooks", express.raw({ type: "application/json" }));
  app.use(express.json());
  app.use(serviceAuth);
  app.use(requireIdentityHeaders);
  app.use(callLog);
  app.use("/", healthRoutes);
  app.use("/", customersRoutes);
  app.use("/", internalCustomersRoutes);
  app.use("/", checkoutSessionsRoutes);
  app.use("/", paymentIntentsRoutes);
  app.use("/", paymentMethodsRoutes);
  app.use("/", billingPortalSessionsRoutes);
  app.use("/", publicStatsRoutes);
  app.use("/", webhooksRoutes);
  return app;
}
