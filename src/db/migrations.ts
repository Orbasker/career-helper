import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client.js";

export async function runMigrations(databaseUrl: string) {
  const { db, pool } = createDb(databaseUrl);
  try {
    await migrate(db, { migrationsFolder: "drizzle" });
  } finally {
    await pool.end();
  }
}
