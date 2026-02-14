import * as dotenv from "dotenv";
import { beforeAll, afterAll } from "vitest";

// Load test environment variables
dotenv.config({ path: ".env.test" });

// Fallback to regular .env if .env.test doesn't exist
if (!process.env.STRIPE_SERVICE_DATABASE_URL) {
  dotenv.config();
}

// Set test-specific defaults
process.env.STRIPE_SERVICE_DATABASE_URL = process.env.STRIPE_SERVICE_DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.STRIPE_SERVICE_API_KEY = process.env.STRIPE_SERVICE_API_KEY || "test-secret-key";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_test_fake";

beforeAll(() => {
  console.log("Test suite starting...");
});

afterAll(() => {
  console.log("Test suite complete.");
});
