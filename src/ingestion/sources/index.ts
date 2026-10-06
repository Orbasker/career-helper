import type { JobSourceAdapter } from "../adapter.js";
import { ashbyAdapter } from "./ashby.js";
import { greenhouseAdapter } from "./greenhouse.js";
import { leverAdapter } from "./lever.js";

export const SOURCE_ADAPTERS: readonly JobSourceAdapter<any>[] = [greenhouseAdapter, leverAdapter, ashbyAdapter];
