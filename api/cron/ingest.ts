import { parseEnv } from "@neon/env";
import { attachDatabasePool } from "@vercel/functions";
import config from "../../neon.js";
import { createDb } from "../../src/db/client.js";
import { createIngestCronHandler } from "../../src/ingestion/cron.js";
import { runIngestion } from "../../src/ingestion/run.js";
import { SOURCE_ADAPTERS } from "../../src/ingestion/sources/index.js";

const { postgres } = parseEnv(config, ["DATABASE_URL"]);
const { db, pool } = createDb(postgres.databaseUrl);
attachDatabasePool(pool);

export const GET = createIngestCronHandler(process.env.CRON_SECRET, () => runIngestion(db, SOURCE_ADAPTERS));
