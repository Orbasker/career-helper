import { describe, expect, it } from "vitest";
import { aliasSnapshot, attributeTo, extractionToChanges, interpretationToChanges } from "../src/ai/mapping.js";
import type { Extraction, Interpretation } from "../src/ai/schemas.js";
import { normalizeDate } from "../src/domain/dates.js";
import type { ProfileSnapshot } from "../src/domain/profile.js";

const EXPERIENCE_ID = "11111111-1111-4111-8111-111111111111";
const FACT_ID = "22222222-2222-4222-8222-222222222222";
const PREFERENCE_ID = "33333333-3333-4333-8333-333333333333";
const HEBREW_CV_ID = "44444444-4444-4444-8444-444444444444";
const LINKEDIN_ID = "55555555-5555-4555-8555-555555555555";

const snapshot: ProfileSnapshot = {
  profile: {
    headline: null,
    summary: null,
    currentSeniority: null,
    managementScope: null,
    openToAdjacentRoles: true,
    linkedinUrl: null,
  },
  experiences: [
    {
      id: EXPERIENCE_ID,
      employer: "Acme",
      title: "HR Manager",
      industry: null,
      location: null,
      seniority: null,
      managedHeadcount: null,
      startDate: "2019-01-01",
      endDate: null,
      isCurrent: true,
    },
  ],
  facts: [{ id: FACT_ID, kind: "skill", statement: "Workday", workExperienceId: EXPERIENCE_ID }],
  preferences: [
    {
      id: PREFERENCE_ID,
      kind: "target_role",
      dimension: "role",
      label: "Recruiting",
      value: { type: "terms", terms: ["recruiting"] },
      status: "active",
    },
  ],
};

describe("profile change mapping", () => {
  it.each([
    ["2021-03", "2021-03-01"],
    ["2021", "2021-01-01"],
    ["2021-02-30", null],
    ["March 2021", null],
    [null, null],
  ])("normalizes date %s", (input, expected) => {
    expect(normalizeDate(input)).toBe(expected);
  });

  it("hides database ids behind aliases", () => {
    const { aliases, view } = aliasSnapshot(snapshot);
    expect(JSON.stringify(view)).not.toContain(EXPERIENCE_ID);
    expect(view).toMatchObject({ facts: [{ id: "f1", experience: "e1" }], preferences: [{ id: "p1" }] });
    expect(aliases.facts.get("f1")).toBe(FACT_ID);
  });

  it("resolves aliases and drops references to unknown items", () => {
    const { aliases } = aliasSnapshot(snapshot);
    const interpretation: Interpretation = {
      reply: null,
      changes: [
        { op: "remove_fact", fact: "f1" },
        { op: "remove_fact", fact: "f99" },
        { op: "remove_experience", experience: "e7" },
        { op: "remove_preference", preference: "p1" },
        {
          op: "add_experience",
          ref: "new1",
          employer: "Globex",
          title: "HRBP",
          industry: null,
          location: null,
          seniority: "senior",
          managedHeadcount: null,
          startDate: "2015-06",
          endDate: "2014",
          isCurrent: false,
        },
        { op: "add_fact", kind: "achievement", statement: " Hired 40 people ", experience: "new1" },
        { op: "add_fact", kind: "skill", statement: "SAP", experience: "e1" },
        { op: "add_fact", kind: "skill", statement: "Excel", experience: "bogus" },
        {
          op: "update_experience",
          experience: "e1",
          employer: null,
          title: null,
          industry: null,
          location: null,
          seniority: null,
          managedHeadcount: 8,
          startDate: null,
          endDate: "2023-06",
          isCurrent: null,
        },
        {
          op: "add_preference",
          kind: "hard_constraint",
          dimension: "location",
          label: "Max 40 min commute",
          value: { type: "location", places: ["Tel Aviv"], maxCommuteMinutes: 40 },
          replaces: "p1",
        },
      ],
    };

    expect(interpretationToChanges(interpretation, aliases)).toEqual([
      { op: "remove_fact", factId: FACT_ID },
      { op: "remove_preference", preferenceId: PREFERENCE_ID },
      {
        op: "add_experience",
        ref: "new1",
        origin: "conversation",
        experience: {
          employer: "Globex",
          title: "HRBP",
          industry: null,
          location: null,
          seniority: "senior",
          managedHeadcount: null,
          startDate: "2015-06-01",
          endDate: null,
          isCurrent: false,
        },
      },
      {
        op: "add_fact",
        kind: "achievement",
        statement: "Hired 40 people",
        experienceId: null,
        experienceRef: "new1",
        origin: "conversation",
      },
      { op: "add_fact", kind: "skill", statement: "SAP", experienceId: EXPERIENCE_ID, experienceRef: null, origin: "conversation" },
      { op: "add_fact", kind: "skill", statement: "Excel", experienceId: null, experienceRef: null, origin: "conversation" },
      {
        op: "update_experience",
        experienceId: EXPERIENCE_ID,
        fields: { managedHeadcount: 8, endDate: "2023-06-01", isCurrent: false },
      },
      {
        op: "add_preference",
        preference: {
          kind: "hard_constraint",
          dimension: "location",
          label: "Max 40 min commute",
          value: { type: "location", places: ["Tel Aviv"], maxCommuteMinutes: 40 },
        },
        replacesPreferenceId: PREFERENCE_ID,
      },
    ]);
  });

  it("turns an extraction into draft changes with source provenance", () => {
    const extraction: Extraction = {
      headline: "HR leader",
      summary: null,
      currentSeniority: "manager",
      managementScope: null,
      openToAdjacentRoles: null,
      experiences: [
        {
          employer: "Acme",
          title: "HR Manager",
          industry: null,
          location: null,
          seniority: "manager",
          managedHeadcount: 6,
          startDate: "2019-01",
          endDate: "2020-01",
          isCurrent: true,
          source: 2,
          facts: [{ kind: "responsibility", statement: "Ran hiring" }],
        },
        { ...{ employer: " ", title: "Ghost", industry: null, location: null, seniority: null, managedHeadcount: null }, startDate: null, endDate: null, isCurrent: false, source: 1, facts: [] },
      ],
      generalFacts: [
        { kind: "language", statement: "Hebrew (native)", source: 1 },
        { kind: "skill", statement: "Workday", source: 9 },
      ],
      preferences: [
        {
          kind: "hard_constraint",
          dimension: "compensation",
          label: "At least 30k ILS/month",
          value: { type: "compensation", currency: "ILS", min: 30000, max: null, period: "month" },
        },
      ],
      followUpQuestions: ["Which roles?"],
    };

    const sources = [
      { kind: "cv" as const, content: "קורות חיים", documentId: HEBREW_CV_ID, language: "he" },
      { kind: "linkedin_export" as const, content: "Page 1 of 2", documentId: LINKEDIN_ID, language: "en" },
    ];
    expect(extractionToChanges(extraction, sources)).toEqual([
      { op: "update_profile", fields: { headline: "HR leader", currentSeniority: "manager" } },
      {
        op: "add_experience",
        ref: "x0",
        origin: "linkedin_import",
        sourceDocumentId: LINKEDIN_ID,
        experience: expect.objectContaining({ employer: "Acme", startDate: "2019-01-01", endDate: null, isCurrent: true }),
      },
      {
        op: "add_fact",
        kind: "responsibility",
        statement: "Ran hiring",
        experienceId: null,
        experienceRef: "x0",
        origin: "linkedin_import",
        sourceDocumentId: LINKEDIN_ID,
      },
      {
        op: "add_fact",
        kind: "language",
        statement: "Hebrew (native)",
        experienceId: null,
        experienceRef: null,
        origin: "cv_upload",
        sourceDocumentId: HEBREW_CV_ID,
      },
      {
        op: "add_fact",
        kind: "skill",
        statement: "Workday",
        experienceId: null,
        experienceRef: null,
        origin: "cv_upload",
        sourceDocumentId: null,
      },
      {
        op: "add_preference",
        preference: {
          kind: "hard_constraint",
          dimension: "compensation",
          label: "At least 30k ILS/month",
          value: { type: "compensation", currency: "ILS", min: 30000, period: "month" },
        },
        replacesPreferenceId: null,
      },
    ]);
  });

  it("attributes additions from an uploaded document to it and leaves other changes alone", () => {
    const changes = interpretationToChanges(
      {
        reply: null,
        changes: [
          { op: "add_fact", kind: "skill", statement: "BambooHR", experience: "e1" },
          { op: "remove_fact", fact: "f1" },
        ],
      },
      aliasSnapshot(snapshot).aliases,
    );
    expect(attributeTo(changes, { kind: "linkedin_export", content: "", documentId: LINKEDIN_ID, language: "en" })).toEqual([
      {
        op: "add_fact",
        kind: "skill",
        statement: "BambooHR",
        experienceId: EXPERIENCE_ID,
        experienceRef: null,
        origin: "linkedin_import",
        sourceDocumentId: LINKEDIN_ID,
      },
      { op: "remove_fact", factId: FACT_ID },
    ]);
  });
});
