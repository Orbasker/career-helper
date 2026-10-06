import { parseEnv } from "@neon/env";
import config from "../neon.js";
import { createDb } from "../src/db/client.js";
import { buildStats, formatStats, gatewaySpend } from "../src/observability/report.js";

const days = Number(process.argv[2] ?? 7);
const { postgres } = parseEnv(config, ["DATABASE_URL"]);
const { db, pool } = createDb(postgres.databaseUrl);
try {
  console.log(formatStats(await buildStats(db, { days, spend: gatewaySpend })));
} finally {
  await pool.end();
}
