import { writeFileSync } from "node:fs";
import type { JobSourceAdapter, NormalizedJobFields, RawJob } from "../src/ingestion/adapter.js";
import { normalizeCompany, normalizeLocation, normalizeTitle } from "../src/ingestion/normalize.js";
import type { JobQuery, JobSearchSource } from "../src/ingestion/search.js";
import { SEARCH_SOURCES, SOURCE_ADAPTERS } from "../src/ingestion/sources/index.js";
import { politeFetch } from "../src/ingestion/sources/shared.js";

/** Compares job sources on live data without a database: `bun scripts/benchmark-sources.ts [--details N] [--out file.json]`. */

const QUERIES: { profile: string; query: JobQuery }[] = [
  { profile: "Hebrew · Israel", query: { keywords: "מנהל מוצר", location: null } },
  { profile: "Hebrew · Israel", query: { keywords: "מפתח backend", location: null } },
  { profile: "Hebrew · Israel", query: { keywords: "אנליסט נתונים", location: null } },
  { profile: "English · Israel", query: { keywords: "Backend Engineer", location: "Tel Aviv" } },
  { profile: "English · Israel", query: { keywords: "Product Manager", location: null } },
  { profile: "English · Israel", query: { keywords: "HR Business Partner", location: null } },
  { profile: "Remote", query: { keywords: "Backend Engineer", location: "Remote" } },
];

const BOARDS: Record<string, unknown[]> = {
  greenhouse: ["wizinc", "riskified", "payoneer", "melio", "taboola", "similarweb", "axonius"],
  comeet: ["silverfort/54.007", "team8/61.003", "drivenets/72.006", "vastdata/43.001"],
  workable: ["rayzone-group", "d-id", "autofleet"],
  smartrecruiters: ["wix2"],
  workday: ["nvidia.wd5/NVIDIAExternalCareerSite"],
};

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const detailsPerQuery = Number(arg("details") ?? 8);
const out = arg("out");

interface Posting {
  source: string;
  profile: string | null;
  key: string;
  company: string | null;
  title: string;
  relevant: boolean;
}

interface SourceStats {
  source: string;
  kind: "job_site" | "board";
  requests: number;
  scanned: number;
  open: number;
  staleOrInvalid: number;
  relevant: number;
  uniqueRelevant: number;
  duplicateRate: number;
  companies: number;
  newCompanies: number;
  errors: string[];
  durationMs: number;
  byProfile: Record<string, number>;
}

const BASELINE = new Set(["greenhouse", "lever", "ashby"]);
const tokens = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);
const queryTokens = QUERIES.map(({ profile, query }) => ({ profile, words: tokens(query.keywords) }));

function postingOf(source: string, profile: string | null, fields: NormalizedJobFields): Posting {
  const title = normalizeTitle(fields.title) ?? fields.title.toLowerCase();
  const company = normalizeCompany(fields.company);
  const titleWords = new Set(tokens(fields.title));
  const relevant = profile !== null || queryTokens.some((q) => q.words.every((w) => titleWords.has(w)));
  return { source, profile, key: `${title}|${company ?? "?"}|${normalizeLocation(fields.location) ?? ""}`, company, title, relevant };
}

function counting(fetcher: typeof fetch) {
  const counter = { requests: 0 };
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    counter.requests++;
    return fetcher(input, init);
  }) as typeof fetch;
  return { fetch: wrapped, counter };
}

async function benchSite(site: JobSearchSource<any>): Promise<{ stats: SourceStats; postings: Posting[] }> {
  const started = Date.now();
  const { fetch, counter } = counting(globalThis.fetch);
  const ctx = { fetch: politeFetch(fetch, { minIntervalMs: site.requestIntervalMs }), limit: 25 };
  const postings: Posting[] = [];
  const errors: string[] = [];
  let scanned = 0;
  let stale = 0;
  for (const { profile, query } of QUERIES) {
    let listed: RawJob<any>[] = [];
    try {
      listed = await site.search(query, ctx);
    } catch (error) {
      errors.push(`${query.keywords}: ${(error as Error).message}`);
      continue;
    }
    scanned += listed.length;
    for (const raw of listed.slice(0, site.details ? detailsPerQuery : listed.length)) {
      try {
        const full = site.details ? await site.details(raw, ctx) : raw;
        const fields = full && site.normalize(full);
        if (!fields) stale++;
        else postings.push(postingOf(site.source.key, profile, fields));
      } catch (error) {
        errors.push(`${raw.externalId}: ${(error as Error).message}`);
      }
    }
  }
  return { stats: emptyStats(site.source.key, "job_site", counter.requests, scanned, stale, errors, started), postings };
}

async function benchBoards(adapter: JobSourceAdapter<any>): Promise<{ stats: SourceStats; postings: Posting[] }> {
  const started = Date.now();
  const { fetch, counter } = counting(globalThis.fetch);
  const errors: string[] = [];
  const postings: Posting[] = [];
  let scanned = 0;
  let stale = 0;
  const records = adapter.collect({
    since: null,
    config: { boards: BOARDS[adapter.source.key] ?? [] },
    fetch,
    reportError: (scope, error) => errors.push(`${scope}: ${(error as Error).message}`),
  });
  for await (const raw of records) {
    scanned++;
    const fields = adapter.normalize(raw);
    if (!fields) stale++;
    else postings.push(postingOf(adapter.source.key, null, fields));
  }
  return { stats: emptyStats(adapter.source.key, "board", counter.requests, scanned, stale, errors, started), postings };
}

function emptyStats(source: string, kind: SourceStats["kind"], requests: number, scanned: number, stale: number, errors: string[], started: number): SourceStats {
  return {
    source,
    kind,
    requests,
    scanned,
    open: 0,
    staleOrInvalid: stale,
    relevant: 0,
    uniqueRelevant: 0,
    duplicateRate: 0,
    companies: 0,
    newCompanies: 0,
    errors,
    durationMs: Date.now() - started,
    byProfile: {},
  };
}

const runs = await Promise.all([
  ...SEARCH_SOURCES.map(benchSite),
  ...SOURCE_ADAPTERS.filter((a) => BOARDS[a.source.key]).map(benchBoards),
]);

const sourcesByKey = new Map<string, Set<string>>();
for (const { postings } of runs) for (const p of postings) sourcesByKey.set(p.key, (sourcesByKey.get(p.key) ?? new Set()).add(p.source));
const baselineCompanies = new Set(runs.flatMap((r) => r.postings).filter((p) => BASELINE.has(p.source) && p.company).map((p) => p.company!));

const stats = runs.map(({ stats, postings }) => {
  const relevant = postings.filter((p) => p.relevant);
  const keys = new Set(relevant.map((p) => p.key));
  const companies = new Set(postings.map((p) => p.company).filter((c): c is string => c !== null));
  const byProfile: Record<string, number> = {};
  for (const p of relevant) if (p.profile) byProfile[p.profile] = (byProfile[p.profile] ?? 0) + 1;
  return {
    ...stats,
    open: postings.length,
    relevant: keys.size,
    uniqueRelevant: [...keys].filter((k) => sourcesByKey.get(k)!.size === 1).length,
    duplicateRate: relevant.length ? Math.round((1 - keys.size / relevant.length) * 100) / 100 : 0,
    companies: companies.size,
    newCompanies: [...companies].filter((c) => !baselineCompanies.has(c)).length,
    byProfile,
  };
});

const crossSource = [...sourcesByKey.values()].filter((s) => s.size > 1).length;
const report = { ranAt: new Date().toISOString(), detailsPerQuery, queries: QUERIES, boards: BOARDS, crossSourceDuplicates: crossSource, stats };
if (out) writeFileSync(out, JSON.stringify(report, null, 2));

const pad = (v: unknown, n: number) => String(v).padEnd(n);
console.log(
  [
    "source           kind      req  scanned open stale relevant unique dup%  companies new  ms",
    ...stats.map((s) =>
      [
        pad(s.source, 16),
        pad(s.kind, 9),
        pad(s.requests, 4),
        pad(s.scanned, 7),
        pad(s.open, 4),
        pad(s.staleOrInvalid, 5),
        pad(s.relevant, 8),
        pad(s.uniqueRelevant, 6),
        pad(Math.round(s.duplicateRate * 100), 5),
        pad(s.companies, 9),
        pad(s.newCompanies, 4),
        s.durationMs,
      ].join(" "),
    ),
    `postings found on more than one source: ${crossSource}`,
    ...stats.flatMap((s) => s.errors.slice(0, 3).map((e) => `! ${s.source}: ${e}`)),
  ].join("\n"),
);
