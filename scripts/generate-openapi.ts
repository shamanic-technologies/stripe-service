import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "../src/schemas";
import * as fs from "fs";

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Stripe Service API",
    description:
      "Payment processing service built on Stripe. Handles checkout sessions, payment intents, webhook processing for payment events, and integrates with runs-service for cost tracking.",
    version: "1.0.0",
  },
  servers: [
    { url: "https://stripe.mcpfactory.org", description: "Production" },
    { url: "http://localhost:3011", description: "Local development" },
  ],
  tags: [
    { name: "Health", description: "Health check endpoints" },
    { name: "Payments", description: "Create payments via Stripe" },
    { name: "Payment Status", description: "Query payment status and stats" },
    { name: "Webhooks", description: "Stripe webhook handlers" },
  ],
});

fs.writeFileSync("openapi.json", JSON.stringify(document, null, 2));
console.log("Generated openapi.json");
