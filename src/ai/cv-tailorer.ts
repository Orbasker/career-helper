import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import type { ProfileSnapshot } from "../domain/profile.js";
import {
  MAX_BULLETS,
  MAX_BULLETS_PER_ROLE,
  MAX_SUMMARY_SENTENCES,
  groundTailoring,
  type CvTailorer,
  type TailoredCv,
  type TailoringJob,
} from "../cv/tailoring.js";
import { EXPLANATION_MODEL, renderProfile } from "./deep-matcher.js";
import { noopRecorder, tracked, type ModelCallRecorder } from "./tracking.js";

export const CV_TAILORING_PROMPT_VERSION = "cv-tailoring-v1";
const MAX_DESCRIPTION_CHARS = 20_000;

const INSTRUCTIONS = `You tailor a candidate's CV to one job. You see their verified career history, where every experience (e*) and fact (f*) has an id, and the job posting.

Your job is to choose, order and reword; never to add.
- highlights: pick the responsibility, achievement and other facts that matter most for this job, most relevant first (at most ${MAX_BULLETS_PER_ROLE} per role, ${MAX_BULLETS} in total). Rewrite each as one CV bullet that uses the job's language where it truly fits. A bullet may only restate its own fact: same scope, same numbers, same employer. Never add numbers, dates, employers, tools, qualifications or results the fact does not state. If a fact cannot be made more relevant without adding something, keep its wording.
- skills: the ids of the skill facts that matter for this job, most relevant first. Do not reword skills.
- summary: up to ${MAX_SUMMARY_SENTENCES} sentences presenting the candidate for this job, each citing the ids it relies on. Only say what those ids state. No years-of-experience counts unless a cited fact states them.
- applicationNote: a concise note (3–5 sentences) the candidate could send with the application, addressed to the hiring team, citing the ids it relies on. It may name the company and role. Do not claim anything the cited ids do not state, and do not promise anything on the candidate's behalf.
- Write in the language the candidate's facts are written in.
- Never output scores, percentages of fit or ids inside the text.`;

const draftSchema = z.object({
  summary: z.array(z.object({ text: z.string(), sources: z.array(z.string()).describe("Ids (f*, e*) the sentence relies on") })),
  highlights: z.array(z.object({ fact: z.string().describe("The f* id this bullet restates"), text: z.string() })),
  skills: z.array(z.string()).describe("Ids of skill facts, most relevant first"),
  applicationNote: z.object({ text: z.string(), sources: z.array(z.string()).describe("Ids (f*, e*) the note relies on") }),
});

/** Asks a language model to select, order and reword verified facts, retrying once when the result claims too much. */
export class AiCvTailorer implements CvTailorer {
  readonly promptVersion = CV_TAILORING_PROMPT_VERSION;
  readonly model: string;

  constructor(
    private readonly languageModel: LanguageModel = EXPLANATION_MODEL,
    private readonly recorder: ModelCallRecorder = noopRecorder,
  ) {
    this.model = typeof languageModel === "string" ? languageModel : languageModel.modelId;
  }

  async tailor({ profile, job }: { profile: ProfileSnapshot; job: TailoringJob }): Promise<TailoredCv> {
    const { text: profileText, aliases } = renderProfile(profile);
    const prompt = `<candidate>\n${profileText}\n</candidate>\n\n<job>\n${renderJob(job)}\n</job>`;

    let result = groundTailoring(await this.draft(prompt), aliases, profile, job);
    if (result.violations.length === 0) return result;

    const retry = groundTailoring(
      await this.draft(
        `${prompt}\n\n<rejected>\nYour previous attempt claimed things the cited facts do not state:\n${result.violations.map((v) => `- ${v}`).join("\n")}\nOnly restate what the cited facts say.\n</rejected>`,
      ),
      aliases,
      profile,
      job,
    );
    if (retry.violations.length <= result.violations.length) result = retry;
    return result;
  }

  private async draft(prompt: string) {
    const { output } = await tracked(this.recorder, "cv.tailor", this.model, (providerOptions) =>
      generateText({
        providerOptions,
        model: this.languageModel,
        instructions: INSTRUCTIONS,
        prompt,
        output: Output.object({ schema: draftSchema }),
      }),
    );
    return output;
  }
}

function renderJob(job: TailoringJob): string {
  return [`Title: ${job.title}`, `Company: ${job.company ?? "unknown"}`, "", job.description.slice(0, MAX_DESCRIPTION_CHARS)].join("\n");
}
