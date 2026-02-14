import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { normalizeSslMode } from "./utils";

const connectionString = process.env.STRIPE_SERVICE_DATABASE_URL;

if (!connectionString) {
  throw new Error("STRIPE_SERVICE_DATABASE_URL is required");
}

const pool = new Pool({
  connectionString: normalizeSslMode(connectionString),
});

export const db = drizzle(pool, { schema });
export { pool };
