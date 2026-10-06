import { errorMessage } from "../ingestion/ingest.js";
import type { MatchRecommendation } from "../domain/enums.js";
import type { PreferenceSnapshot, ProfileSnapshot } from "../domain/profile.js";
import type { DeepMatcher, DeepMatchJob, DeepMatchVerdict } from "./deep-match.js";

export type EvalGroup = "obvious_hr" | "adjacent" | "negative";

export interface DeepMatchEvalCase {
  id: string;
  group: EvalGroup;
  job: DeepMatchJob;
  accept: MatchRecommendation[];
}

export interface DeepMatchEvalResult {
  case: DeepMatchEvalCase;
  verdict: DeepMatchVerdict | null;
  problems: string[];
}

const FIT: MatchRecommendation[] = ["strong_fit", "good_fit"];
const ADJACENT: MatchRecommendation[] = ["good_fit", "stretch"];
const NEGATIVE: MatchRecommendation[] = ["not_recommended"];

const preference = (
  id: string,
  kind: PreferenceSnapshot["kind"],
  label: string,
  value: PreferenceSnapshot["value"],
): PreferenceSnapshot => ({
  id,
  kind,
  label,
  value,
  dimension: value.type === "terms" ? "role" : value.type === "free_text" ? "other" : value.type,
  status: "active",
});

export const EVAL_PROFILE: ProfileSnapshot = {
  profile: {
    headline: "Senior HR Business Partner",
    summary: "HR business partner for fast-growing software companies, focused on R&D organizations.",
    currentSeniority: "senior",
    managementScope: "Managed a team of 3 HR generalists",
    openToAdjacentRoles: true,
    linkedinUrl: null,
  },
  experiences: [
    {
      id: "exp-current",
      employer: "Nimbus Software",
      title: "Senior HR Business Partner",
      industry: "Software",
      location: "Tel Aviv",
      seniority: "senior",
      managedHeadcount: 3,
      startDate: "2021-03-01",
      endDate: null,
      isCurrent: true,
    },
    {
      id: "exp-previous",
      employer: "Orbit Retail",
      title: "HR Generalist",
      industry: "Retail",
      location: "Petah Tikva",
      seniority: "mid",
      managedHeadcount: null,
      startDate: "2017-01-01",
      endDate: "2021-02-01",
      isCurrent: false,
    },
  ],
  facts: [
    { id: "f-partner", kind: "responsibility", statement: "HR business partner for an R&D organization of 250 employees", workExperienceId: "exp-current" },
    { id: "f-team", kind: "responsibility", statement: "Managed a team of 3 HR generalists", workExperienceId: "exp-current" },
    { id: "f-reviews", kind: "achievement", statement: "Redesigned the performance review process, adopted company-wide", workExperienceId: "exp-current" },
    { id: "f-attrition", kind: "achievement", statement: "Reduced regretted attrition in R&D from 14% to 8% in two years", workExperienceId: "exp-current" },
    { id: "f-comp", kind: "responsibility", statement: "Ran annual compensation planning and salary benchmarking with finance", workExperienceId: "exp-current" },
    { id: "f-relations", kind: "responsibility", statement: "Handled employee relations cases and terminations in line with Israeli labor law", workExperienceId: "exp-current" },
    { id: "f-onboarding", kind: "achievement", statement: "Built the onboarding program for 400 hires across 30 retail branches", workExperienceId: "exp-previous" },
    { id: "f-hris", kind: "responsibility", statement: "Administered the HRIS and monthly attendance reporting for payroll", workExperienceId: "exp-previous" },
    { id: "f-vendors", kind: "responsibility", statement: "Managed vendors for benefits, training and recruitment agencies", workExperienceId: "exp-previous" },
    { id: "f-training", kind: "responsibility", statement: "Ran manager training workshops on feedback and difficult conversations", workExperienceId: "exp-previous" },
    { id: "f-degree", kind: "education", statement: "BA in Behavioral Sciences, Ben-Gurion University", workExperienceId: null },
    { id: "f-hebrew", kind: "language", statement: "Hebrew (native), English (fluent)", workExperienceId: null },
    { id: "f-excel", kind: "skill", statement: "Advanced Excel and HR analytics dashboards", workExperienceId: null },
  ],
  preferences: [
    preference("p-location", "hard_constraint", "Central Israel or remote", { type: "location", places: ["Israel"] }),
    preference("p-salary", "hard_constraint", "At least 28,000 ILS per month", {
      type: "compensation",
      currency: "ILS",
      min: 28_000,
      period: "month",
    }),
    preference("p-hrbp", "target_role", "HR Business Partner", { type: "terms", terms: ["HR Business Partner"] }),
    preference("p-peopleops", "target_role", "People Operations", { type: "terms", terms: ["People Operations"] }),
    preference("p-tech", "soft_preference", "Tech companies", { type: "terms", terms: ["software", "tech"] }),
    preference("p-recruiting", "dislike", "Pure recruiting roles", { type: "terms", terms: ["recruiter", "talent acquisition"] }),
  ],
};

const job = (title: string, description: string, overrides: Partial<DeepMatchJob> = {}): DeepMatchJob => ({
  title,
  description,
  company: "Example Co",
  location: "Tel Aviv, Israel",
  workMode: "hybrid",
  employmentType: "full_time",
  ...overrides,
});

export const EVAL_CASES: DeepMatchEvalCase[] = [
  {
    id: "hrbp-rnd",
    group: "obvious_hr",
    accept: FIT,
    job: job(
      "Senior HR Business Partner, R&D",
      "Partner with R&D leadership for a 300-person engineering organization. Own performance reviews, compensation cycles, employee relations and retention. 5+ years as an HRBP in tech. Hebrew and English.",
    ),
  },
  {
    id: "people-ops-lead",
    group: "obvious_hr",
    accept: FIT,
    job: job(
      "People Operations Lead",
      "Lead people operations for a 200-person SaaS company: HRIS, onboarding, performance cycles, compensation benchmarking and HR analytics. Manage a team of 2. Experience with Israeli labor law required.",
    ),
  },
  {
    id: "hr-manager",
    group: "obvious_hr",
    accept: FIT,
    job: job(
      "HR Manager",
      "Own the full HR function for a 150-person product company: employee relations, onboarding, performance management, compensation and manager training. Report to the COO.",
    ),
  },
  {
    id: "talent-culture",
    group: "adjacent",
    accept: [...FIT, "stretch"],
    job: job(
      "Talent & Culture Lead",
      "Shape culture and engagement for a growing fintech. Run engagement surveys, manager development programs, performance processes and retention initiatives. Partner with founders on org design.",
    ),
  },
  {
    id: "ld-manager",
    group: "adjacent",
    accept: ADJACENT,
    job: job(
      "Learning & Development Manager",
      "Build the company's learning strategy: leadership programs, manager training, onboarding curriculum and vendor management for external trainers. Measure program impact.",
    ),
  },
  {
    id: "operations-manager",
    group: "adjacent",
    accept: ADJACENT,
    job: job(
      "Operations Manager",
      "Run internal operations for a 120-person startup: office and vendor management, onboarding logistics, policies, budget tracking and cross-team processes. Lead a team of 3 office and operations coordinators.",
    ),
  },
  {
    id: "chief-of-staff",
    group: "adjacent",
    accept: ADJACENT,
    job: job(
      "Chief of Staff to the COO",
      "Drive company-wide initiatives with the COO: org design, OKR process, leadership team cadence, internal communications and special projects across HR, finance and operations.",
    ),
  },
  {
    id: "backend-engineer",
    group: "negative",
    accept: NEGATIVE,
    job: job(
      "Senior Backend Engineer",
      "Design and build backend services in Go, operate Kubernetes clusters and tune PostgreSQL performance. 5+ years of backend development.",
    ),
  },
  {
    id: "financial-controller",
    group: "negative",
    accept: NEGATIVE,
    job: job(
      "Financial Controller",
      "Own monthly close, consolidated financial statements, audits and tax filings. CPA required, 5+ years in audit or controlling.",
    ),
  },
  {
    id: "field-sales",
    group: "negative",
    accept: NEGATIVE,
    job: job(
      "Field Sales Representative",
      "Visit retail customers across the north, hit quarterly revenue quota and grow accounts. Commission-based compensation. Driving license and own car required.",
      { location: "Haifa, Israel", workMode: "onsite" },
    ),
  },
  {
    id: "hrbp-underpaid",
    group: "negative",
    accept: NEGATIVE,
    job: job(
      "HR Business Partner",
      "HRBP for a 100-person logistics company: employee relations, performance reviews and onboarding. Salary: 13,000–15,000 ILS per month.",
    ),
  },
  {
    id: "technical-recruiter",
    group: "negative",
    accept: NEGATIVE,
    job: job(
      "Technical Recruiter",
      "Full-cycle recruiting for engineering roles: sourcing on LinkedIn, screening calls, interview coordination and closing offers. Hiring targets of 8 hires per quarter.",
    ),
  },
];

const FIT_SCORE = /\d+(?:\.\d+)?\s?%\s*(?:match|fit)|\b(?:match|fit)\s+(?:score|rating)\b/i;

/** Checks a verdict against a case: an accepted recommendation, grounded evidence for fits, no numeric fit scores. */
export function checkVerdict(evalCase: DeepMatchEvalCase, verdict: DeepMatchVerdict): string[] {
  const problems: string[] = [];
  if (!evalCase.accept.includes(verdict.recommendation)) {
    problems.push(`expected ${evalCase.accept.join(" | ")}, got ${verdict.recommendation}`);
  }
  if (verdict.recommendation !== "not_recommended" && !verdict.evidence.fitEvidence.length) {
    problems.push("recommended without grounded fit evidence");
  }
  if (!verdict.explanation) problems.push("empty explanation");
  if (FIT_SCORE.test(verdict.explanation)) problems.push("explanation states a numeric fit score");
  return problems;
}

export async function runDeepMatchEval(
  matcher: DeepMatcher,
  cases: readonly DeepMatchEvalCase[] = EVAL_CASES,
  profile: ProfileSnapshot = EVAL_PROFILE,
): Promise<DeepMatchEvalResult[]> {
  return Promise.all(
    cases.map(async (evalCase) => {
      try {
        const verdict = await matcher.evaluate({ profile, job: evalCase.job });
        return { case: evalCase, verdict, problems: checkVerdict(evalCase, verdict) };
      } catch (error) {
        return { case: evalCase, verdict: null, problems: [`error: ${errorMessage(error)}`] };
      }
    }),
  );
}
