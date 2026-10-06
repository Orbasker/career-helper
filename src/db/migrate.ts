import { parseEnv } from "@neon/env";
import config from "../../neon.js";
import { runMigrations } from "./migrations.js";

const { postgres } = parseEnv(config, ["DATABASE_URL_UNPOOLED"]);
await runMigrations(postgres.databaseUrlUnpooled);
