import { db } from "../../src/db";
import {
  stripePayments,
  stripePaymentSuccesses,
  stripePaymentFailures,
  stripeRefunds,
  stripeDisputes,
  stripeCheckoutSessions,
} from "../../src/db/schema";
import { randomUUID } from "crypto";

export { db };

export function generateUUID(): string {
  return randomUUID();
}

export async function cleanupTestData() {
  await db.delete(stripeCheckoutSessions);
  await db.delete(stripeDisputes);
  await db.delete(stripeRefunds);
  await db.delete(stripePaymentFailures);
  await db.delete(stripePaymentSuccesses);
  await db.delete(stripePayments);
}

export async function insertTestPayment(overrides: Partial<typeof stripePayments.$inferInsert> = {}) {
  const [payment] = await db
    .insert(stripePayments)
    .values({
      orgId: "org_test123",
      amountInCents: 1000,
      currency: "usd",
      status: "pending",
      stripePaymentIntentId: `pi_test_${generateUUID().slice(0, 8)}`,
      ...overrides,
    })
    .returning();
  return payment;
}
