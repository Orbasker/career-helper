import { generateText, Output, type LanguageModel } from "ai";
import { noopRecorder, tracked, type ModelCallRecorder } from "./tracking.js";
import type { ProfileAssistant, ProfileExtraction, ProfileInterpretation, ProfileSourceText } from "../app/services.js";
import type { ProfileSnapshot } from "../domain/profile.js";
import { aliasSnapshot, extractionToChanges, interpretationToChanges } from "./mapping.js";
import { extractionSchema, interpretationSchema } from "./schemas.js";

export const PROFILE_MODEL = "anthropic/claude-sonnet-5.5";
const MAX_SOURCE_CHARS = 60_000;

const EXTRACTION_INSTRUCTIONS = `You turn a job seeker's CVs, LinkedIn export and notes into a structured career profile.

Rules:
- Only record what the sources state. Never invent employers, dates, numbers, skills or achievements.
- A CV's wording is the candidate's own marketing, not verified truth: keep each claim as stated and the candidate will confirm it.
- The candidate may send several CVs, often the same career in different languages (e.g. Hebrew and English). Treat them as one career.
- Merge duplicates: the same role often appears in several documents. Emit it once, preferring the most detailed source, and set "source" to that document's index.
- Write all profile text in English, translating from other languages. Keep employer and product names as the English document spells them, otherwise transliterate.
- Facts are short, self-contained statements in the candidate's voice without "I" (e.g. "Managed a team of 6 recruiters"). Keep numbers exactly as written.
- Put responsibilities, achievements and role-specific skills under the role. Put education, certifications, languages and general skills in generalFacts.
- Dates use YYYY-MM (or YYYY). Mark the current role with isCurrent=true and endDate=null.
- Seniority uses the closest of: entry, junior, mid, senior, lead, manager, director, executive.
- Preferences: only explicit statements about what the candidate wants or refuses (location, work mode, target roles, etc.). Do not infer preferences from past jobs.
- followUpQuestions: up to 4 short, friendly questions, most valuable first, only for information that is missing and matters for job matching:
  * target roles and whether they're open to adjacent roles (always ask unless the sources already say so),
  * hard constraints: location / max commute and work mode (onsite / hybrid / remote),
  * management scope when they led people but the size is unclear,
  * compensation expectations (mention it's optional).
  Do not ask about anything the sources already answer.`;

const INTERPRETATION_INSTRUCTIONS = `You maintain a job seeker's structured career profile. Translate the user's message into precise profile changes.

The profile has three separate areas — never mix them:
- Career history: experiences (e*) and facts (f*). Only what the user actually did.
- Preferences (p*): target_role, hard_constraint (must-haves such as location, commute, work mode, minimum salary), soft_preference (nice-to-haves), dislike (things to avoid).
- Profile fields: headline, summary, currentSeniority, managementScope, openToAdjacentRoles.

Rules:
- Reference existing items only by the ids given in the profile. Use add_experience with a ref like "new1" when a new role is needed, and point add_fact at that ref.
- "I'm no longer interested in X roles": remove matching target_role preferences and add a dislike (dimension "role", terms value) for X.
- Corrections to an existing fact use update_fact; corrections to a role's dates/title/employer use update_experience.
- Replacing a preference (e.g. a new commute limit) uses add_preference with "replaces" set to the old id.
- Never invent achievements, numbers or employers the user did not state.
- If the message answers a question you were given, interpret it in that context. "skip", "no", "none" or similar mean no changes.
- If the message is not a profile change (a question, small talk) or is too ambiguous to act on, return no changes and a one-sentence reply. Otherwise reply is null.`;

export class AiProfileAssistant implements ProfileAssistant {
  constructor(
    private readonly model: LanguageModel = PROFILE_MODEL,
    private readonly recorder: ModelCallRecorder = noopRecorder,
  ) {}

  private get modelName(): string {
    return typeof this.model === "string" ? this.model : this.model.modelId;
  }

  async extract(input: { linkedinUrl: string | null; sources: ProfileSourceText[] }): Promise<ProfileExtraction> {
    const documents = input.sources
      .map((s, i) => {
        const language = s.language ? ` language="${s.language}"` : "";
        return `<document index="${i + 1}" kind="${s.kind}"${language}>\n${s.content.slice(0, MAX_SOURCE_CHARS)}\n</document>`;
      })
      .join("\n\n");
    const { output } = await tracked(this.recorder, "profile.extract", this.modelName, (providerOptions) =>
      generateText({
        providerOptions,
        model: this.model,
        instructions: EXTRACTION_INSTRUCTIONS,
        prompt: `LinkedIn profile URL: ${input.linkedinUrl ?? "not provided"}\n\n${documents}`,
        output: Output.object({ schema: extractionSchema }),
      }),
    );
    return { changes: extractionToChanges(output, input.sources), followUpQuestions: output.followUpQuestions };
  }

  async interpret(input: { snapshot: ProfileSnapshot; message: string; question: string | null }): Promise<ProfileInterpretation> {
    const { aliases, view } = aliasSnapshot(input.snapshot);
    const prompt = [
      `Current profile:\n${JSON.stringify(view, null, 1)}`,
      input.question ? `Question the user is answering: ${input.question}` : null,
      `User message: ${input.message}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const { output } = await tracked(this.recorder, "profile.interpret", this.modelName, (providerOptions) =>
      generateText({
        providerOptions,
        model: this.model,
        instructions: INTERPRETATION_INSTRUCTIONS,
        prompt,
        output: Output.object({ schema: interpretationSchema }),
      }),
    );
    return { changes: interpretationToChanges(output, aliases), reply: output.reply };
  }
}
