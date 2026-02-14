import express from "express";
import cors from "cors";
import { serviceAuth } from "../../src/middleware/serviceAuth";
import healthRoutes from "../../src/routes/health";
import paymentRoutes from "../../src/routes/payments";
import statusRoutes from "../../src/routes/status";
import webhooksRoutes from "../../src/routes/webhooks";
import productRoutes from "../../src/routes/products";

export function createTestApp() {
  const app = express();

  app.use(cors());

  // Raw body for webhook signature verification
  app.use(
    "/webhooks/stripe",
    express.raw({ type: "application/json" })
  );

  app.use(express.json());
  app.use(serviceAuth);

  app.use("/", healthRoutes);
  app.use("/", paymentRoutes);
  app.use("/", statusRoutes);
  app.use("/", webhooksRoutes);
  app.use("/", productRoutes);

  return app;
}
