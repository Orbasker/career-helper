import { parseEnv } from "@neon/env";
import { attachDatabasePool } from "@vercel/functions";
import config from "../../neon.js";
import { PgGmailService } from "../../src/app/postgres/gmail.js";
import { createDb } from "../../src/db/client.js";
import { gmailDepsFromEnv } from "../../src/google/env.js";
import { createGoogleConnectHandler } from "../../src/google/routes.js";

const { postgres } = parseEnv(config, ["DATABASE_URL"]);
const { db, pool } = createDb(postgres.databaseUrl);
attachDatabasePool(pool);

export const GET = createGoogleConnectHandler(new PgGmailService(db, gmailDepsFromEnv()));
