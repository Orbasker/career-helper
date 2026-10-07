import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { jobSources, jobs } from "../db/schema.js";
import type { Db } from "../db/types.js";
import type { EmploymentType, WorkMode } from "../domain/enums.js";
import type { JobSourceAdapter, NormalizedJobFields, RawJob } from "../ingestion/adapter.js";
import { deduplicateJobs } from "../ingestion/dedup.js";
import { ingestFromSource } from "../ingestion/ingest.js";
import { SOURCE_ADAPTERS } from "../ingestion/sources/index.js";
import { boardsFromConfig } from "../ingestion/sources/shared.js";
import { atsPostingFromUrl, type AtsPosting } from "./ats.js";
import { RobotsCache, USER_AGENT, jobPostingFromJsonLd, pageText, type PostingCheck } from "./page.js";
import type { JobDiscoverer } from "./plan.js";
import { UnsafeUrlError, publicFetch, type HostResolver } from "./safe-fetch.js";

export const USER_SUBMITTED_SOURCE_KEY = "user_submitted";
const MAX_PAGE_BYTES = 2_000_000;
const TIMEOUT_MS = 15_000;
const LOGIN_PATH = /\/(?:log-?in|sign-?in|auth|sso|accounts?\/login)\b/i;
const TRACKING_PARAM = /^(?:utm_\w+|gclid|fbclid|trk|trackingId|refId)$/i;

export interface SubmittedPostingPayload {
  /** The link as the user sent it. */
  url: string;
  submittedBy: string;
  method: "ats_api" | "json_ld" | "llm";
  job: {
    title: string;
    description: string;
    company: string | null;
    location: string | null;
    workMode: WorkMode | null;
    employmentType: EmploymentType | null;
    publishedAt: string | null;
  };
}

/** An in-memory source over postings users sent the bot, so they go through normal ingestion and deduplication. */
export function userSubmittedAdapter(records: readonly RawJob<SubmittedPostingPayload>[]): JobSourceAdapter<SubmittedPostingPayload> {
  return {
    source: { key: USER_SUBMITTED_SOURCE_KEY, name: "Sent by users", kind: "manual" },
    collect: () => records,
    normalize: ({ payload: { job } }) => ({ ...job, publishedAt: job.publishedAt ? new Date(job.publishedAt) : null }),
  };
}

export type PostingReader = Pick<JobDiscoverer, "extract">;

export interface SubmittedJobDeps {
  reader: PostingReader;
  fetch?: typeof fetch;
  resolveHost?: HostResolver;
  now?: () => Date;
}

export type SubmittedJob =
  | { kind: "job"; groupId: string; known: boolean }
  | { kind: "invalid" }
  | { kind: "inaccessible" }
  | { kind: "login_required" }
  | { kind: "gone" }
  | { kind: "closed" }
  | { kind: "not_a_job" }
  | { kind: "unavailable" };

/** A link from user input with fragments and tracking parameters removed; null when it is not an http(s) URL. */
export function submittedUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim().replace(/[.,;!?)\]>]+$/, ""));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  return url.toString();
}

/**
 * Turns a link the user sent into a deduplicated job: a posting we already know is reused as is; otherwise it is read
 * from the ATS API, the page's JobPosting data or, as a fallback, by the model, and ingested as the `user_submitted`
 * source. Pages that are closed, gated, missing or not a single posting store nothing.
 */
export async function readSubmittedJob(db: Db, userId: string, input: string, deps: SubmittedJobDeps): Promise<SubmittedJob> {
  const now = deps.now ?? (() => new Date());
  const url = submittedUrl(input);
  if (!url) return { kind: "invalid" };
  const ats = atsPostingFromUrl(url);

  const known = await knownGroup(db, [url], ats);
  if (known) return { kind: "job", groupId: known, known: true };

  const fetcher = publicFetch(deps.fetch, deps.resolveHost);
  let read: Read;
  try {
    read = ats ? await readAtsPosting(db, ats, fetcher) : await readPage(url, fetcher, deps.reader, now());
  } catch (error) {
    if (error instanceof UnsafeUrlError) return { kind: "invalid" };
    console.warn("submitted job unreadable", { url, error });
    return { kind: "inaccessible" };
  }
  if (read.kind !== "posting") return read;
  const knownAt = read.sourceUrl !== url ? await knownGroup(db, [read.sourceUrl], null) : null;
  if (knownAt) return { kind: "job", groupId: knownAt, known: true };

  const record: RawJob<SubmittedPostingPayload> = {
    externalId: ats ? `${ats.source}:${ats.token}:${ats.postingId}` : null,
    sourceUrl: read.sourceUrl,
    payload: {
      url,
      submittedBy: userId,
      method: read.method,
      job: {
        title: read.fields.title,
        description: read.fields.description,
        company: read.fields.company ?? null,
        location: read.fields.location ?? null,
        workMode: read.fields.workMode ?? null,
        employmentType: read.fields.employmentType ?? null,
        publishedAt: read.fields.publishedAt?.toISOString() ?? null,
      },
    },
  };
  const report = await ingestFromSource(db, userSubmittedAdapter([record]), { now });
  if (report.disabled) return { kind: "unavailable" };
  const problem = report.invalid[0]?.issues.join("; ") ?? report.failed[0]?.error ?? report.errors[0]?.error;
  if (problem) throw new Error(`Could not store submitted job ${url}: ${problem}`);

  await deduplicateJobs(db, { now });
  const [job] = await db
    .select({ groupId: jobs.duplicateGroupId })
    .from(jobs)
    .innerJoin(jobSources, eq(jobSources.id, jobs.sourceId))
    .where(and(eq(jobSources.key, USER_SUBMITTED_SOURCE_KEY), eq(jobs.sourceUrl, record.sourceUrl)));
  if (!job?.groupId) throw new Error(`Submitted job ${url} was not grouped`);
  return { kind: "job", groupId: job.groupId, known: false };
}

type Read =
  | { kind: "posting"; sourceUrl: string; method: SubmittedPostingPayload["method"]; fields: NormalizedJobFields }
  | Exclude<SubmittedJob, { kind: "job" }>;

/** A grouped job with one of these URLs, or the same ATS posting collected from its board or sent before. */
async function knownGroup(db: Db, urls: string[], ats: AtsPosting | null): Promise<string | null> {
  const byPosting = ats
    ? or(
        and(eq(jobSources.key, ats.source), eq(jobs.externalId, `${ats.token}:${ats.postingId}`)),
        and(eq(jobSources.key, USER_SUBMITTED_SOURCE_KEY), eq(jobs.externalId, `${ats.source}:${ats.token}:${ats.postingId}`)),
      )
    : undefined;
  const [row] = await db
    .select({ groupId: jobs.duplicateGroupId })
    .from(jobs)
    .innerJoin(jobSources, eq(jobSources.id, jobs.sourceId))
    .where(and(isNotNull(jobs.duplicateGroupId), or(inArray(jobs.sourceUrl, urls), byPosting)))
    .limit(1);
  return row?.groupId ?? null;
}

async function readPage(url: string, fetcher: typeof fetch, reader: PostingReader, now: Date): Promise<Read> {
  if (!(await new RobotsCache(fetcher).allows(url))) return { kind: "inaccessible" };
  const response = await fetcher(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const finalUrl = response.url || url;
  if (response.status === 401 || LOGIN_PATH.test(new URL(finalUrl).pathname)) return { kind: "login_required" };
  if (response.status === 404 || response.status === 410) return { kind: "gone" };
  if (!response.ok) return { kind: "inaccessible" };
  if (!(response.headers.get("content-type") ?? "").includes("html")) return { kind: "not_a_job" };
  const html = (await response.text()).slice(0, MAX_PAGE_BYTES);
  let method: SubmittedPostingPayload["method"] = "json_ld";
  let check: PostingCheck = jobPostingFromJsonLd(html, now);
  if (check.kind === "none") {
    method = "llm";
    check = await reader.extract({ url: finalUrl, text: pageText(html) });
  }
  if (check.kind === "closed") return { kind: "closed" };
  if (check.kind === "none") return { kind: "not_a_job" };
  return { kind: "posting", sourceUrl: finalUrl, method, fields: check.fields };
}

const ATS_API: Record<AtsPosting["source"], (p: AtsPosting) => string> = {
  greenhouse: (p) =>
    `https://boards-api${p.eu ? ".eu" : ""}.greenhouse.io/v1/boards/${encodeURIComponent(p.token)}/jobs/${p.postingId}?content=true`,
  lever: (p) => `https://api${p.eu ? ".eu" : ""}.lever.co/v0/postings/${encodeURIComponent(p.token)}/${p.postingId}?mode=json`,
  ashby: (p) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(p.token)}?includeCompensation=true`,
};

/** Reads one posting through the board's official API and maps it with that board's adapter. */
async function readAtsPosting(db: Db, ats: AtsPosting, fetcher: typeof fetch): Promise<Read> {
  const response = await fetcher(ATS_API[ats.source](ats), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 404) return { kind: "gone" };
  if (!response.ok) return { kind: "inaccessible" };
  type Posting = Record<string, unknown> & { id?: unknown };
  const body = (await response.json()) as Posting & { jobs?: Posting[] };
  const posting = ats.source === "ashby" ? body.jobs?.find((j) => String(j.id).toLowerCase() === ats.postingId) : body;
  if (!posting) return { kind: "gone" };

  const adapter = SOURCE_ADAPTERS.find((a) => a.source.key === ats.source)!;
  const [source] = await db.select({ config: jobSources.config }).from(jobSources).where(eq(jobSources.key, ats.source));
  const company = boardsFromConfig(source?.config ?? {}).find((b) => b.token.toLowerCase() === ats.token)?.company ?? null;
  const sourceUrl = [posting.absolute_url, posting.hostedUrl, posting.jobUrl].find((u): u is string => typeof u === "string");
  const raw = { externalId: `${ats.token}:${ats.postingId}`, sourceUrl: sourceUrl ?? "", payload: { board: ats.token, company, posting } };
  const fields = adapter.normalize(raw);
  if (!fields || !sourceUrl) return { kind: "not_a_job" };
  return { kind: "posting", sourceUrl, method: "ats_api", fields };
}
