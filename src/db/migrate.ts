import { parseEnv } from "@neon/env";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import config from "../../neon.js";
import { createDb } from "./client.js";

const { postgres } = parseEnv(config, ["DATABASE_URL_UNPOOLED"]);
const { db, pool } = createDb(postgres.databaseUrlUnpooled);

try {
  await migrate(db, { migrationsFolder: "drizzle" });
} finally {
  await pool.end();
}
