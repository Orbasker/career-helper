import { z } from "zod";
import {
  CAREER_FACT_KINDS,
  EMPLOYMENT_TYPES,
  PREFERENCE_DIMENSIONS,
  PREFERENCE_KINDS,
  PROFILE_SOURCE_KINDS,
  SENIORITY_LEVELS,
  WORK_MODES,
} from "../domain/enums.js";
import type { PreferenceValue } from "../domain/types.js";

const seniority = z.enum(SENIORITY_LEVELS).nullable();
const partialDate = z.string().nullable().describe("YYYY-MM, or YYYY when the month is unknown");

export const preferenceValueSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("location"),
    places: z.array(z.string()),
    maxCommuteMinutes: z.number().int().nullable(),
  }),
  z.object({ type: z.literal("work_mode"), modes: z.array(z.enum(WORK_MODES)) }),
  z.object({ type: z.literal("employment_type"), types: z.array(z.enum(EMPLOYMENT_TYPES)) }),
  z.object({
    type: z.literal("compensation"),
    currency: z.string().describe("ISO 4217 code"),
    min: z.number().nullable(),
    max: z.number().nullable(),
    period: z.enum(["month", "year"]),
  }),
  z.object({ type: z.literal("seniority"), levels: z.array(z.enum(SENIORITY_LEVELS)) }),
  z.object({ type: z.literal("terms"), terms: z.array(z.string()) }),
  z.object({ type: z.literal("free_text"), text: z.string() }),
]);

export const preferenceSchema = z.object({
  kind: z.enum(PREFERENCE_KINDS),
  dimension: z.enum(PREFERENCE_DIMENSIONS),
  label: z.string().describe("Short human-readable statement, e.g. 'Remote or hybrid only'"),
  value: preferenceValueSchema,
});

export const experienceSchema = z.object({
  employer: z.string(),
  title: z.string(),
  industry: z.string().nullable(),
  location: z.string().nullable(),
  seniority,
  managedHeadcount: z.number().int().nullable().describe("People managed directly or indirectly, if stated"),
  startDate: partialDate,
  endDate: partialDate,
  isCurrent: z.boolean(),
});

export const extractionSchema = z.object({
  headline: z.string().nullable().describe("One-line professional headline"),
  summary: z.string().nullable().describe("2-3 sentence factual career summary"),
  currentSeniority: seniority,
  managementScope: z.string().nullable().describe("Largest people/budget scope managed, if stated"),
  openToAdjacentRoles: z.boolean().nullable(),
  experiences: z.array(
    experienceSchema.extend({
      source: z.enum(PROFILE_SOURCE_KINDS),
      facts: z.array(
        z.object({
          kind: z.enum(["responsibility", "achievement", "skill", "other"]),
          statement: z.string(),
        }),
      ),
    }),
  ),
  generalFacts: z
    .array(z.object({ kind: z.enum(CAREER_FACT_KINDS), statement: z.string(), source: z.enum(PROFILE_SOURCE_KINDS) }))
    .describe("Skills, education, certifications and languages not tied to one role"),
  preferences: z.array(preferenceSchema).describe("Only preferences the candidate explicitly states"),
  followUpQuestions: z.array(z.string()).max(5),
});

const unchangedIfNull = "null means unchanged";

export const interpretationSchema = z.object({
  reply: z
    .string()
    .nullable()
    .describe("Short message to the user when no change applies or something is ambiguous; null otherwise"),
  changes: z.array(
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("update_profile"),
        headline: z.string().nullable(),
        summary: z.string().nullable(),
        currentSeniority: seniority,
        managementScope: z.string().nullable(),
        openToAdjacentRoles: z.boolean().nullable(),
      }).describe(`Profile-level fields; ${unchangedIfNull}`),
      experienceSchema.extend({
        op: z.literal("add_experience"),
        ref: z.string().describe("Temporary id such as 'new1' that add_fact can reference"),
      }),
      z.object({
        op: z.literal("update_experience"),
        experience: z.string().describe("Existing experience id, e.g. 'e2'"),
        employer: z.string().nullable(),
        title: z.string().nullable(),
        industry: z.string().nullable(),
        location: z.string().nullable(),
        seniority,
        managedHeadcount: z.number().int().nullable(),
        startDate: partialDate,
        endDate: partialDate,
        isCurrent: z.boolean().nullable(),
      }).describe(`Fields to change on an existing experience; ${unchangedIfNull}`),
      z.object({ op: z.literal("remove_experience"), experience: z.string() }),
      z.object({
        op: z.literal("add_fact"),
        kind: z.enum(CAREER_FACT_KINDS),
        statement: z.string(),
        experience: z.string().nullable().describe("Existing experience id or a new experience ref; null if general"),
      }),
      z.object({
        op: z.literal("update_fact"),
        fact: z.string().describe("Existing fact id, e.g. 'f4'"),
        kind: z.enum(CAREER_FACT_KINDS).nullable(),
        statement: z.string(),
      }),
      z.object({ op: z.literal("remove_fact"), fact: z.string() }),
      preferenceSchema.extend({
        op: z.literal("add_preference"),
        replaces: z.string().nullable().describe("Existing preference id this one replaces, e.g. 'p1'"),
      }),
      z.object({ op: z.literal("remove_preference"), preference: z.string() }),
    ]),
  ),
});

export type Extraction = z.infer<typeof extractionSchema>;
export type Interpretation = z.infer<typeof interpretationSchema>;

export function toPreferenceValue(value: z.infer<typeof preferenceValueSchema>): PreferenceValue {
  switch (value.type) {
    case "location":
      return value.maxCommuteMinutes === null
        ? { type: "location", places: value.places }
        : { type: "location", places: value.places, maxCommuteMinutes: value.maxCommuteMinutes };
    case "compensation": {
      const { min, max, ...rest } = value;
      return { ...rest, ...(min === null ? {} : { min }), ...(max === null ? {} : { max }) };
    }
    default:
      return value;
  }
}
