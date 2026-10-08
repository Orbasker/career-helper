import type { JobSourceAdapter } from "../adapter.js";
import type { JobSearchSource } from "../search.js";
import { alljobsSource } from "./alljobs.js";
import { ashbyAdapter } from "./ashby.js";
import { comeetAdapter } from "./comeet.js";
import { drushimSource } from "./drushim.js";
import { greenhouseAdapter } from "./greenhouse.js";
import { jobmasterSource } from "./jobmaster.js";
import { leverAdapter } from "./lever.js";
import { linkedinSource } from "./linkedin.js";
import { smartRecruitersAdapter } from "./smartrecruiters.js";
import { workableAdapter } from "./workable.js";
import { workdayAdapter } from "./workday.js";

export const SOURCE_ADAPTERS: readonly JobSourceAdapter<any>[] = [
  greenhouseAdapter,
  leverAdapter,
  ashbyAdapter,
  comeetAdapter,
  workableAdapter,
  smartRecruitersAdapter,
  workdayAdapter,
];

export const SEARCH_SOURCES: readonly JobSearchSource<any>[] = [linkedinSource, alljobsSource, drushimSource, jobmasterSource];
