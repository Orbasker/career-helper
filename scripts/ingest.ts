import { parseEnv } from "@neon/env";
import config from "../neon.js";
import { createDb } from "../src/db/client.js";
import { runIngestion } from "../src/ingestion/run.js";
import { SOURCE_ADAPTERS } from "../src/ingestion/sources/index.js";

const requested = process.argv.slice(2);
const unknown = requested.filter((key) => !SOURCE_ADAPTERS.some((a) => a.source.key === key));
if (unknown.length) {
  const known = SOURCE_ADAPTERS.map((a) => a.source.key).join(", ");
  throw new Error(`Unknown source(s): ${unknown.join(", ")}. Known: ${known}`);
}
const adapters = requested.length ? SOURCE_ADAPTERS.filter((a) => requested.includes(a.source.key)) : SOURCE_ADAPTERS;

const { postgres } = parseEnv(config, ["DATABASE_URL"]);
const { db, pool } = createDb(postgres.databaseUrl);
try {
  const reports = await runIngestion(db, adapters);
  if (reports.some((r) => r.errors.length)) process.exitCode = 1;
} finally {
  await pool.end();
}
