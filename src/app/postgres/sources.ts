import { and, desc, eq, gte, isNotNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { jobSources, jobs, pipelineRuns, rawJobRecords } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import { WEB_SEARCH_SOURCE_KEY } from "../../discovery/run.js";
import { boardsFromConfig } from "../../ingestion/sources/shared.js";
import type {
  BoardSourceView,
  JobOrigin,
  SiteService,
  SourceCoverage,
  SourceIssue,
  SourceService,
  SourcesOverview,
} from "../services.js";

export const COVERAGE_DAYS = 7;

const NON_BOARD_KINDS = ["web_search", "manual"];

/** The job's origin for `userId`; needs `jobs` joined with `job_sources` and `raw_job_records`. */
export function jobOrigin(userId: string) {
  const foundBy = sql`${rawJobRecords.payload}->'foundBy'`;
  return sql<JobOrigin>`case
    when ${jobSources.kind} = 'manual' then 'user_link'
    when ${jobSources.kind} = 'web_search' then
      case when ${foundBy}->>'userId' = ${userId} and ${foundBy}->>'site' = 'true' then 'user_site' else 'web_search' end
    else 'board' end`;
}

interface StageResult {
  ok: boolean;
  error?: string;
  report?: Record<string, any>;
}

interface IngestSummary {
  source: string;
  errors: number;
  errorScopes?: string[];
}

export class PgSourceService implements SourceService {
  constructor(
    private readonly db: Db,
    private readonly sites: SiteService,
  ) {}

  async overview(userId: string): Promise<SourcesOverview> {
    const sources = await this.db
      .select({ key: jobSources.key, name: jobSources.name, kind: jobSources.kind, enabled: jobSources.isEnabled, config: jobSources.config, lastCollectedAt: jobSources.lastCollectedAt })
      .from(jobSources)
      .orderBy(jobSources.key);
    const boardRows = sources.filter((s) => !NON_BOARD_KINDS.includes(s.kind));
    const boardSources: BoardSourceView[] = boardRows.map((s) => ({
      name: s.name,
      enabled: s.enabled,
      boards: boardsFromConfig(s.config).map((b) => b.company ?? b.token),
      lastCollectedAt: s.lastCollectedAt,
    }));
    const webSource = sources.find((s) => s.key === WEB_SEARCH_SOURCE_KEY);

    const [lastRun] = await this.db
      .select({ report: pipelineRuns.report })
      .from(pipelineRuns)
      .where(isNotNull(pipelineRuns.finishedAt))
      .orderBy(desc(pipelineRuns.startedAt))
      .limit(1);
    const discovery = lastRun?.report?.discovery as StageResult | null | undefined;
    const ingestion = lastRun?.report?.ingestion as StageResult | undefined;
    const webEnabled = webSource?.enabled !== false && !(lastRun && (discovery === null || discovery?.report?.disabled));

    const [searched] = await this.db
      .select({ at: sql<Date | null>`max(${pipelineRuns.startedAt})`.mapWith((v) => (v ? new Date(v) : null)) })
      .from(pipelineRuns)
      .where(sql`${pipelineRuns.report}->'discovery'->'report'->'searchedUsers' @> ${JSON.stringify([userId])}::jsonb`);

    const issues: SourceIssue[] = [];
    for (const source of boardRows) {
      if (!source.enabled) {
        issues.push({ kind: "turned_off", source: source.name });
        continue;
      }
      const summary = (ingestion?.report?.sources as IngestSummary[] | undefined)?.find((s) => s.source === source.key);
      if (!summary || summary.errors === 0) continue;
      const boards = (summary.errorScopes ?? []).filter((s) => s.startsWith("board:")).map((s) => s.slice("board:".length));
      issues.push(
        boards.length === summary.errors
          ? { kind: "unreachable_boards", source: source.name, boards }
          : { kind: "collection_failed", source: source.name },
      );
    }
    if (ingestion && !ingestion.ok) issues.push({ kind: "collection_failed", source: "Company job boards" });
    if (!webEnabled) issues.push({ kind: "turned_off", source: webSource?.name ?? "Agent web search" });
    else if (discovery && !discovery.ok) issues.push({ kind: "search_failed" });
    else if ((discovery?.report?.errors as { scope: string }[] | undefined)?.some((e) => e.scope === `user:${userId}`)) {
      issues.push({ kind: "user_search_failed" });
    }

    const coverage = await this.coverage(userId);
    return {
      coverageDays: COVERAGE_DAYS,
      boardSources,
      boardCoverage: coverage.board,
      webSearch: { enabled: webEnabled, lastSearchedAt: searched?.at ?? null, coverage: coverage.web_search },
      sites: await this.sites.list(userId),
      siteCoverage: coverage.user_site,
      issues,
    };
  }

  private async coverage(userId: string, now = new Date()): Promise<Record<JobOrigin, SourceCoverage>> {
    const since = new Date(now.getTime() - COVERAGE_DAYS * 86_400_000);
    const earlier = alias(jobs, "earlier");
    const isNewCompany = and(
      isNotNull(jobs.normalizedCompany),
      notExists(
        this.db
          .select({ one: sql`1` })
          .from(earlier)
          .where(and(eq(earlier.normalizedCompany, jobs.normalizedCompany), sql`${earlier.createdAt} < ${since}`)),
      ),
    );
    const origin = jobOrigin(userId);
    const rows = await this.db
      .select({
        origin,
        jobs: sql<number>`count(*)`.mapWith(Number),
        newCompanies: sql<number>`count(distinct ${jobs.normalizedCompany}) filter (where ${isNewCompany})`.mapWith(Number),
      })
      .from(jobs)
      .innerJoin(jobSources, eq(jobSources.id, jobs.sourceId))
      .innerJoin(rawJobRecords, eq(rawJobRecords.id, jobs.rawRecordId))
      .where(gte(jobs.createdAt, since))
      .groupBy(sql`1`);
    const empty = (): SourceCoverage => ({ jobs: 0, newCompanies: 0 });
    const result: Record<JobOrigin, SourceCoverage> = { board: empty(), user_site: empty(), web_search: empty(), user_link: empty() };
    for (const row of rows) result[row.origin] = { jobs: row.jobs, newCompanies: row.newCompanies };
    return result;
  }
}
