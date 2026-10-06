import { parseEnv } from "@neon/env";
import config from "../neon.js";
import { AiDeepMatcher } from "../src/ai/deep-matcher.js";
import { createDb } from "../src/db/client.js";
import { runDeepMatching } from "../src/matching/deep-match.js";
import { PgModelCallRecorder } from "../src/observability/recorder.js";

const { postgres } = parseEnv(config, ["DATABASE_URL"]);
const { db, pool } = createDb(postgres.databaseUrl);
const limit = process.argv[2] ? Number(process.argv[2]) : undefined;
try {
  const report = await runDeepMatching(db, new AiDeepMatcher(undefined, undefined, new PgModelCallRecorder(db)), { limit });
  console.log(JSON.stringify({ event: "match.deep", ...report }));
  if (report.errors.length) process.exitCode = 1;
} finally {
  await pool.end();
}
