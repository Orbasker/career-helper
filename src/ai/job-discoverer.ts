import { gateway, generateText, Output, stepCountIs, type LanguageModel } from "ai";
import { z } from "zod";
import { EMPLOYMENT_TYPES, WORK_MODES } from "../domain/enums.js";
import type { PostingCheck } from "../discovery/page.js";
import type { JobCandidate, JobDiscoverer, SearchPlan } from "../discovery/plan.js";
import { EXPLANATION_MODEL } from "./deep-matcher.js";
import { noopRecorder, tracked, type ModelCallRecorder } from "./tracking.js";

const MAX_RESULTS_PER_SEARCH = 10;

const SEARCH_INSTRUCTIONS = `You find currently open job postings on the web for one job seeker.

Use the search tool with the given queries (you may refine them, e.g. add "careers" or the local language). Then return links to individual postings that are open now and plausibly match the queries.
- Each link must be the page of ONE posting: prefer the company's own careers page or its applicant tracking system (Greenhouse, Lever, Ashby, Comeet, Workable, SmartRecruiters…) over aggregators and re-posts.
- Skip search result pages, company home pages, lists of many jobs, news, blog posts and expired postings.
- Skip jobs that are mainly the kinds of work the candidate wants to avoid.
- Only return URLs that appeared in search results; never construct or guess URLs.`;

const EXTRACT_INSTRUCTIONS = `You read the text of one web page and decide whether it is a single, currently open job posting. If it is, extract its fields exactly as the page states them. Never invent a company, location or requirement; use null when the page does not say. The description is the posting's full text about the role (responsibilities, requirements, benefits), without site navigation.`;

const candidatesSchema = z.object({
  postings: z.array(
    z.object({
      url: z.string().describe("URL of one job posting, exactly as it appeared in search results"),
      title: z.string(),
      company: z.string().nullable(),
    }),
  ),
});

const extractionSchema = z.object({
  isJobPosting: z.boolean().describe("The page is a single job posting, not a list or another kind of page"),
  isOpen: z.boolean().describe("False when the page says the position is closed, filled or expired"),
  title: z.string().nullable(),
  company: z.string().nullable(),
  location: z.string().nullable(),
  workMode: z.enum(WORK_MODES).nullable(),
  employmentType: z.enum(EMPLOYMENT_TYPES).nullable(),
  description: z.string().nullable(),
});

/** A language model with AI Gateway's Perplexity search finds postings; the same model reads pages without job data. */
export class AiJobDiscoverer implements JobDiscoverer {
  readonly model: string;

  constructor(
    private readonly languageModel: LanguageModel = EXPLANATION_MODEL,
    private readonly recorder: ModelCallRecorder = noopRecorder,
  ) {
    this.model = typeof languageModel === "string" ? languageModel : languageModel.modelId;
  }

  async search(plan: SearchPlan): Promise<JobCandidate[]> {
    if (plan.queries.length === 0) return [];
    const search = gateway.tools.perplexitySearch({
      country: plan.country,
      maxResults: MAX_RESULTS_PER_SEARCH,
      searchRecencyFilter: "month",
      ...(plan.domains.length ? { searchDomainFilter: plan.domains.slice(0, 20) } : {}),
    });
    const scope = plan.domains.length ? `Search only these sites: ${plan.domains.join(", ")}.` : "Search the open web.";
    const { output, steps } = await tracked(this.recorder, "discovery.search", this.model, (providerOptions) =>
      generateText({
        providerOptions,
        model: this.languageModel,
        instructions: SEARCH_INSTRUCTIONS,
        prompt: [
          scope,
          `Queries:\n${plan.queries.map((q) => `- ${q}`).join("\n")}`,
          plan.avoid.length ? `The candidate wants to avoid: ${plan.avoid.join("; ")}.` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        tools: { search },
        stopWhen: stepCountIs(plan.queries.length + 2),
        output: Output.object({ schema: candidatesSchema }),
      }),
    );
    const seen = new Set(steps.flatMap((step) => step.toolResults.flatMap((result) => resultUrls(result.output))));
    return output.postings
      .map((p) => ({ url: p.url.trim(), title: p.title.trim(), company: p.company?.trim() || null }))
      .filter((p) => seen.has(p.url));
  }

  async extract({ url, text }: { url: string; text: string }): Promise<PostingCheck> {
    const { output } = await tracked(this.recorder, "discovery.extract", this.model, (providerOptions) =>
      generateText({
        providerOptions,
        model: this.languageModel,
        instructions: EXTRACT_INSTRUCTIONS,
        prompt: `<url>${url}</url>\n\n<page>\n${text}\n</page>`,
        output: Output.object({ schema: extractionSchema }),
      }),
    );
    if (!output.isJobPosting) return { kind: "none" };
    if (!output.isOpen) return { kind: "closed" };
    const title = output.title?.trim();
    const description = output.description?.trim();
    if (!title || !description) return { kind: "none" };
    return {
      kind: "posting",
      fields: {
        title,
        description,
        company: output.company?.trim() || null,
        location: output.location?.trim() || null,
        workMode: output.workMode,
        employmentType: output.employmentType,
      },
    };
  }
}

function resultUrls(output: unknown): string[] {
  const results = (output as { results?: { url?: unknown }[] } | null)?.results;
  return Array.isArray(results) ? results.flatMap((r) => (typeof r.url === "string" ? [r.url.trim()] : [])) : [];
}
