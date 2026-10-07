import type { ConversationLanguage } from "../domain/enums.js";
import { detectLanguage } from "../domain/language.js";
import { errorMessage } from "../ingestion/ingest.js";
import { EVAL_PROFILE } from "../matching/deep-match-eval.js";
import type { ProfileSnapshot } from "../domain/profile.js";
import type { CvTailorer, TailoredCv, TailoringJob } from "./tailoring.js";

export interface CvEvalCase {
  id: string;
  job: TailoringJob;
  language: ConversationLanguage;
  /** Facts a good CV for this job must show among its experience bullets. */
  mustHighlight: string[];
}

export interface CvEvalResult {
  case: CvEvalCase;
  cv: TailoredCv | null;
  problems: string[];
}

export const CV_EVAL_CASES: CvEvalCase[] = [
  {
    id: "hrbp-rnd",
    language: "en",
    job: {
      title: "Senior HR Business Partner, R&D",
      company: "Lumen Labs",
      description:
        "Partner with R&D leadership for a 300-person engineering organization. Own performance reviews, compensation cycles, employee relations and retention. 5+ years as an HRBP in tech. Hebrew and English.",
    },
    mustHighlight: ["f-partner", "f-reviews", "f-attrition"],
  },
  {
    id: "people-ops-lead",
    language: "en",
    job: {
      title: "People Operations Lead",
      company: "Tidewater",
      description:
        "Lead people operations for a 200-person SaaS company: HRIS, onboarding, performance cycles, compensation benchmarking and HR analytics. Manage a team of 2. Experience with Israeli labor law required.",
    },
    mustHighlight: ["f-hris", "f-onboarding", "f-comp"],
  },
  {
    id: "learning-development",
    language: "en",
    job: {
      title: "Learning & Development Manager",
      company: "Northwind",
      description:
        "Build manager training, onboarding journeys and feedback culture programs for a 500-person company. Work with HRBPs on development plans and measure program impact.",
    },
    mustHighlight: ["f-training", "f-onboarding"],
  },
  {
    id: "numbers-heavy-posting",
    language: "en",
    job: {
      title: "HR Business Partner",
      company: "Quanta",
      description:
        "Support 1,200 employees across 6 sites. Cut attrition by 20% within 12 months. 8+ years of HRBP experience, SHRM certification, and experience leading teams of 10.",
    },
    mustHighlight: ["f-partner"],
  },
  {
    id: "hrbp-rnd-hebrew",
    language: "he",
    job: {
      title: "שותפה עסקית משאבי אנוש, מחקר ופיתוח",
      company: "Lumen Labs",
      description:
        "ליווי הנהלת מחקר ופיתוח בארגון של 300 מהנדסים. אחריות על תהליכי הערכת ביצועים, סבבי תגמול, יחסי עובדים ושימור. 5+ שנות ניסיון כ-HRBP בהייטק. עברית ואנגלית.",
    },
    mustHighlight: ["f-partner", "f-reviews", "f-attrition"],
  },
];

/** Problems with one tailored CV: invented claims, lines without a verified fact, and missing key facts or sections. */
export function checkCv(evalCase: CvEvalCase, cv: TailoredCv, profile: ProfileSnapshot = EVAL_PROFILE): string[] {
  const problems = cv.violations.map((v) => `unsupported claim: ${v}`);
  const factIds = new Set(profile.facts.map((f) => f.id));
  for (const item of cv.items) {
    if (!factIds.has(item.careerFactId)) problems.push(`line cites unknown fact ${item.careerFactId}`);
  }
  const bullets = new Set(cv.items.filter((i) => i.section === "experience").map((i) => i.careerFactId));
  for (const id of evalCase.mustHighlight) if (!bullets.has(id)) problems.push(`missing key fact ${id}`);
  if (!cv.items.some((i) => i.section === "summary")) problems.push("no summary");
  for (const item of cv.items) {
    if ((item.section === "summary" || item.section === "experience") && detectLanguage(item.text) !== evalCase.language) {
      problems.push(`not in ${evalCase.language}: “${item.text}”`);
    }
  }
  if (!cv.applicationNote) problems.push("no application note");
  return problems;
}

export async function runCvEval(
  tailorer: CvTailorer,
  cases: readonly CvEvalCase[] = CV_EVAL_CASES,
  profile: ProfileSnapshot = EVAL_PROFILE,
): Promise<CvEvalResult[]> {
  return Promise.all(
    cases.map(async (evalCase) => {
      try {
        const cv = await tailorer.tailor({
          profile,
          job: evalCase.job,
          language: evalCase.language,
          styleReference: null,
          keep: { highlights: [], skills: [] },
        });
        return { case: evalCase, cv, problems: checkCv(evalCase, cv, profile) };
      } catch (error) {
        return { case: evalCase, cv: null, problems: [`error: ${errorMessage(error)}`] };
      }
    }),
  );
}
