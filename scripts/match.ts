import { parseEnv } from "@neon/env";
import config from "../neon.js";
import { createDb } from "../src/db/client.js";
import { runCheapMatching } from "../src/matching/run.js";

const { postgres } = parseEnv(config, ["DATABASE_URL"]);
const { db, pool } = createDb(postgres.databaseUrl);
try {
  const report = await runCheapMatching(db);
  console.log(JSON.stringify({ event: "match.cheap", ...report }));
  if (report.errors.length) process.exitCode = 1;
} finally {
  await pool.end();
}
