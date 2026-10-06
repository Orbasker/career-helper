import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../../src/db/schema.js";

export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "drizzle" });
  return { db, close: () => client.close() };
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];

export async function expectDbError(query: PromiseLike<unknown>, pattern: RegExp) {
  try {
    await query;
  } catch (error) {
    const cause = (error as { cause?: Error }).cause ?? (error as Error);
    if (!pattern.test(cause.message)) throw cause;
    return;
  }
  throw new Error(`expected query to fail with ${pattern}`);
}
