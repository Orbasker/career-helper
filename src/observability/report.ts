import { desc, eq, gte, sql } from "drizzle-orm";
import { gateway } from "ai";
import { cvVersions, feedback, jobSources, jobs, matches, modelCalls, pipelineRuns } from "../db/schema.js";
import type { Db } from "../db/types.js";

export interface SpendRow {
  tag: string;
  cost: number;
}

/** Spend per gateway tag between two `YYYY-MM-DD` dates (inclusive). */
export type SpendLookup = (startDate: string, endDate: string) => Promise<SpendRow[]>;

export const gatewaySpend: SpendLookup = async (startDate, endDate) => {
  const { results } = await gateway.getSpendReport({ startDate, endDate, groupBy: "tag" });
  return results.flatMap((row) => (row.tag ? [{ tag: row.tag, cost: row.totalCost }] : []));
};

export interface StatsReport {
  days: number;
  since: Date;
  runs: { total: number; failed: number; unfinished: number };
  lastRun: { startedAt: Date; finishedAt: Date | null; failed: boolean | null; summary: string[] } | null;
  newJobs: { source: string; jobs: number }[];
  funnel: {
    matched: number;
    hardFiltered: number;
    lowRelevance: number;
    deepEvaluated: number;
    recommended: number;
    notified: number;
    pendingDeep: number;
  };
  feedback: { interested: number; notInterested: number };
  cvs: { requested: number; approved: number; failed: number };
  modelCalls: { purpose: string; calls: number; errors: number; inputTokens: number; outputTokens: number; avgMs: number }[];
  spend: { rows: SpendRow[]; total: number } | { error: string } | null;
}

const count = (condition?: ReturnType<typeof sql>) =>
  (condition ? sql<number>`count(*) filter (where ${condition})` : sql<number>`count(*)`).mapWith(Number);

/** Funnel, run, usage and spend numbers for the last `days` days. */
export async function buildStats(
  db: Db,
  { days = 7, now = new Date(), spend }: { days?: number; now?: Date; spend?: SpendLookup } = {},
): Promise<StatsReport> {
  const since = new Date(now.getTime() - days * 86_400_000);

  const [runs] = await db
    .select({ total: count(), failed: count(sql`${pipelineRuns.failed}`), unfinished: count(sql`${pipelineRuns.finishedAt} is null`) })
    .from(pipelineRuns)
    .where(gte(pipelineRuns.startedAt, since));
  const [last] = await db.select().from(pipelineRuns).orderBy(desc(pipelineRuns.startedAt)).limit(1);

  const newJobs = await db
    .select({ source: jobSources.key, jobs: count() })
    .from(jobs)
    .innerJoin(jobSources, eq(jobSources.id, jobs.sourceId))
    .where(gte(jobs.createdAt, since))
    .groupBy(jobSources.key)
    .orderBy(desc(count()));

  const [funnel] = await db
    .select({
      matched: count(),
      hardFiltered: count(sql`${matches.status} = 'filtered_out' and ${matches.stageReached} = 'hard_filter'`),
      lowRelevance: count(sql`${matches.status} = 'filtered_out' and ${matches.stageReached} = 'cheap_relevance'`),
      deepEvaluated: count(sql`${matches.stageReached} = 'deep_match'`),
      recommended: count(sql`${matches.recommendation} in ('strong_fit', 'good_fit', 'stretch')`),
      notified: count(sql`${matches.notifiedAt} is not null`),
      pendingDeep: count(sql`${matches.status} = 'pending'`),
    })
    .from(matches)
    .where(gte(matches.createdAt, since));

  const [feedbackCounts] = await db
    .select({ interested: count(sql`${feedback.verdict} = 'interested'`), notInterested: count(sql`${feedback.verdict} = 'not_interested'`) })
    .from(feedback)
    .where(gte(feedback.createdAt, since));

  const [cvs] = await db
    .select({ requested: count(), approved: count(sql`${cvVersions.status} = 'approved'`), failed: count(sql`${cvVersions.status} = 'failed'`) })
    .from(cvVersions)
    .where(gte(cvVersions.createdAt, since));

  const calls = await db
    .select({
      purpose: modelCalls.purpose,
      calls: count(),
      errors: count(sql`not ${modelCalls.ok}`),
      inputTokens: sql<number>`coalesce(sum(${modelCalls.inputTokens}), 0)`.mapWith(Number),
      outputTokens: sql<number>`coalesce(sum(${modelCalls.outputTokens}), 0)`.mapWith(Number),
      avgMs: sql<number>`coalesce(round(avg(${modelCalls.durationMs})), 0)`.mapWith(Number),
    })
    .from(modelCalls)
    .where(gte(modelCalls.createdAt, since))
    .groupBy(modelCalls.purpose)
    .orderBy(modelCalls.purpose);

  let spendReport: StatsReport["spend"] = null;
  if (spend) {
    try {
      const rows = (await spend(isoDate(since), isoDate(now))).filter((r) => r.tag.startsWith("purpose:"));
      spendReport = { rows: rows.sort((a, b) => b.cost - a.cost), total: rows.reduce((sum, r) => sum + r.cost, 0) };
    } catch (error) {
      spendReport = { error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    days,
    since,
    runs: runs ?? { total: 0, failed: 0, unfinished: 0 },
    lastRun: last
      ? { startedAt: last.startedAt, finishedAt: last.finishedAt, failed: last.failed, summary: summarizeRun(last.report) }
      : null,
    newJobs,
    funnel: funnel!,
    feedback: feedbackCounts!,
    cvs: cvs!,
    modelCalls: calls,
    spend: spendReport,
  };
}

/** One line per stage of a stored pipeline report. */
export function summarizeRun(report: Record<string, unknown> | null): string[] {
  if (!report) return [];
  const stage = (name: string) => report[name] as { ok: boolean; report?: Record<string, any>; error?: string } | null | undefined;
  const line = (label: string, name: string, describe: (r: Record<string, any>) => string) => {
    const result = stage(name);
    if (!result) return [];
    return [`${label}: ${result.ok ? describe(result.report ?? {}) : `failed (${result.error})`}`];
  };
  return [
    ...line("Discovery", "discovery", (r) => `${r.searches} searches, ${r.postings} postings, ${r.companies} companies, ${r.boardsAdded?.length ?? 0} boards added`),
    ...line("Collection", "ingestion", (r) => {
      const sources = (r.sources ?? []) as { inserted: number; errors: number }[];
      const inserted = sources.reduce((sum, s) => sum + s.inserted, 0);
      const failing = sources.filter((s) => s.errors > 0).length;
      return `${inserted} new jobs from ${sources.length} sources${failing ? `, ${failing} with errors` : ""}`;
    }),
    ...line("Cheap matching", "cheapMatching", (r) => `${r.evaluated} evaluated, ${r.passed} passed`),
    ...line("Deep matching", "deepMatching", (r) => `${r.evaluated} evaluated, ${r.recommended} recommended`),
    ...line("Notifications", "notifications", (r) => `${r.digestsSent} digests, ${r.matchesNotified} matches`),
  ];
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The report as text: HTML for Telegram, or plain text for the terminal. */
export function formatStats(report: StatsReport, { html = false }: { html?: boolean } = {}): string {
  const esc = (text: string) => (html ? text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : text);
  const bold = (text: string) => (html ? `<b>${esc(text)}</b>` : text.toUpperCase());
  const time = (date: Date | null) => (date ? date.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
  const usd = (value: number) => `$${value.toFixed(value < 1 ? 3 : 2)}`;
  const sections: string[] = [`${bold(`Career agent — last ${report.days} days`)}`];

  const { runs, lastRun } = report;
  const runLines = [`${runs.total} runs, ${runs.failed} failed, ${runs.unfinished} cut off before finishing`];
  if (lastRun) {
    const outcome = lastRun.finishedAt === null ? "did not finish" : lastRun.failed ? "finished with errors" : "ok";
    runLines.push(`Last run ${time(lastRun.startedAt)}: ${outcome}`, ...lastRun.summary.map((line) => `• ${esc(line)}`));
  }
  sections.push(`${bold("Runs")}\n${runLines.join("\n")}`);

  const jobsLine = report.newJobs.length ? report.newJobs.map((s) => `${esc(s.source)} ${s.jobs}`).join(", ") : "none";
  const f = report.funnel;
  sections.push(
    `${bold("Funnel")}\nNew jobs: ${jobsLine}\nMatched ${f.matched} → failed must-haves ${f.hardFiltered}, low relevance ${f.lowRelevance}, deep-matched ${f.deepEvaluated} (${f.pendingDeep} waiting) → recommended ${f.recommended} → notified ${f.notified}`,
  );
  sections.push(
    `${bold("Users")}\nFeedback: 👍 ${report.feedback.interested}, 👎 ${report.feedback.notInterested}\nCVs: ${report.cvs.requested} requested, ${report.cvs.approved} approved, ${report.cvs.failed} failed`,
  );

  const callLines = report.modelCalls.map(
    (c) => `• ${esc(c.purpose)}: ${c.calls} calls${c.errors ? ` (${c.errors} failed)` : ""}, ${c.inputTokens + c.outputTokens} tokens, ~${(c.avgMs / 1000).toFixed(1)}s`,
  );
  sections.push(`${bold("AI calls")}\n${callLines.length ? callLines.join("\n") : "none"}`);

  if (report.spend) {
    const spendText =
      "error" in report.spend
        ? `unavailable (${esc(report.spend.error)})`
        : [`Total ${usd(report.spend.total)}`, ...report.spend.rows.map((r) => `• ${esc(r.tag.replace("purpose:", ""))}: ${usd(r.cost)}`)].join("\n");
    sections.push(`${bold("AI spend (AI Gateway)")}\n${spendText}`);
  }
  return sections.join("\n\n");
}
