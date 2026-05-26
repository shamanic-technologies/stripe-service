import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "../src/schemas";
import * as fs from "fs";

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Stripe Service API",
    description:
      "Thin Stripe wrapper service. Mirrors a subset of the Stripe API surface (customers, checkout sessions, payment intents, billing portal) with local DB-backed caching driven by webhooks + a 5-minute reconciliation poll.",
    version: "2.0.0",
  },
  servers: [
    { url: "https://stripe.distribute.you", description: "Production" },
    { url: "http://localhost:3011", description: "Local development" },
  ],
  tags: [
    { name: "Health", description: "Health check" },
    { name: "Customers", description: "Stripe Customer mirror" },
    { name: "Checkout", description: "Stripe Checkout Session mirror" },
    { name: "PaymentIntents", description: "Stripe PaymentIntent mirror" },
    { name: "PaymentMethods", description: "Stripe PaymentMethod live passthrough" },
    { name: "BillingPortal", description: "Stripe Billing Portal sessions" },
    { name: "Webhooks", description: "Stripe webhook ingestion" },
  ],
});

fs.writeFileSync("openapi.json", JSON.stringify(document, null, 2));
console.log("Generated openapi.json");
