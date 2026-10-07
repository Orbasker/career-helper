import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import type { ConversationLanguage } from "../domain/enums.js";
import {
  MAX_BULLETS,
  MAX_BULLETS_PER_ROLE,
  MAX_SUMMARY_SENTENCES,
  groundTailoring,
  type CvTailorer,
  type TailoredCv,
  type TailoringInput,
  type TailoringJob,
} from "../cv/tailoring.js";
import { EXPLANATION_MODEL, renderProfile } from "./deep-matcher.js";
import { noopRecorder, tracked, type ModelCallRecorder } from "./tracking.js";

export const CV_TAILORING_PROMPT_VERSION = "cv-tailoring-v2";
const MAX_DESCRIPTION_CHARS = 20_000;
const MAX_STYLE_REFERENCE_CHARS = 12_000;
const LANGUAGE_NAMES: Record<ConversationLanguage, string> = { en: "English", he: "Hebrew" };

const instructions = (language: ConversationLanguage) => `You tailor a candidate's CV to one job. You see their verified career history, where every experience (e*) and fact (f*) has an id, and the job posting.

Your job is to choose, order and reword; never to add.
- highlights: pick the responsibility, achievement and other facts that matter most for this job, most relevant first (at most ${MAX_BULLETS_PER_ROLE} per role, ${MAX_BULLETS} in total). Rewrite each as one CV bullet that uses the job's terminology where it truly fits. A bullet may only restate its own fact: same scope, same numbers, same employer. Never add numbers, dates, employers, tools, qualifications or results the fact does not state. If a fact cannot be made more relevant without adding something, keep its wording.
- skills: the ids of the skill facts that matter for this job, most relevant first. Do not reword skills.
- summary: up to ${MAX_SUMMARY_SENTENCES} sentences presenting the candidate for this job, each citing the ids it relies on. Only say what those ids state. No years-of-experience counts unless a cited fact states them.
- applicationNote: a concise note (3–5 sentences) the candidate could send with the application, addressed to the hiring team, citing the ids it relies on. It may name the company and role. Do not claim anything the cited ids do not state, and do not promise anything on the candidate's behalf.
- Write every text in ${LANGUAGE_NAMES[language]}. When a fact is written in another language, translate it faithfully: same meaning, same numbers, names of employers, products and tools kept as written.
- translations: for each skill, education, certification and language fact written in another language than ${LANGUAGE_NAMES[language]}, its id and a faithful translation. Leave out facts already in ${LANGUAGE_NAMES[language]} and names that stay as they are (e.g. Python, Excel).
- A <style_reference> is an earlier CV the candidate wrote in ${LANGUAGE_NAMES[language]}. Use its terminology, phrasing and tone where it describes the same facts. It is not a source of facts: everything you write must still be stated by the ids you cite.
- When a <keep> list is given, the candidate already chose those facts for this job in another language: keep the same highlights and skills in the same order and only translate and reword them.
- Never output scores, percentages of fit or ids inside the text.`;

const draftSchema = z.object({
  summary: z.array(z.object({ text: z.string(), sources: z.array(z.string()).describe("Ids (f*, e*) the sentence relies on") })),
  highlights: z.array(z.object({ fact: z.string().describe("The f* id this bullet restates"), text: z.string() })),
  skills: z.array(z.string()).describe("Ids of skill facts, most relevant first"),
  translations: z.array(z.object({ fact: z.string().describe("The f* id translated"), text: z.string() })).default([]),
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

  async tailor({ profile, job, language, styleReference, keep }: TailoringInput): Promise<TailoredCv> {
    const { text: profileText, aliases } = renderProfile(profile);
    const aliasOf = new Map([...aliases.facts].map(([alias, id]) => [id, alias]));
    const keepAliases = (ids: string[]) => ids.flatMap((id) => aliasOf.get(id) ?? []);
    const sections = [`<candidate>\n${profileText}\n</candidate>`, `<job>\n${renderJob(job)}\n</job>`];
    if (styleReference) sections.push(`<style_reference>\n${styleReference.slice(0, MAX_STYLE_REFERENCE_CHARS)}\n</style_reference>`);
    if (keep.highlights.length || keep.skills.length) {
      sections.push(`<keep>\nhighlights: ${keepAliases(keep.highlights).join(", ")}\nskills: ${keepAliases(keep.skills).join(", ")}\n</keep>`);
    }
    const prompt = sections.join("\n\n");
    const ground = (draft: z.infer<typeof draftSchema>) => groundTailoring(draft, aliases, profile, job, language);

    let result = ground(await this.draft(language, prompt));
    if (result.violations.length === 0) return result;

    const retry = ground(
      await this.draft(
        language,
        `${prompt}\n\n<rejected>\nYour previous attempt claimed things the cited facts do not state:\n${result.violations.map((v) => `- ${v}`).join("\n")}\nOnly restate what the cited facts say.\n</rejected>`,
      ),
    );
    if (retry.violations.length <= result.violations.length) result = retry;
    return result;
  }

  private async draft(language: ConversationLanguage, prompt: string) {
    const { output } = await tracked(this.recorder, "cv.tailor", this.model, (providerOptions) =>
      generateText({
        providerOptions,
        model: this.languageModel,
        instructions: instructions(language),
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
