import { describe, expect, it } from "vitest";
import type { MatchSummary } from "../src/app/services.js";
import { digestView, matchListItem } from "../src/bot/views.js";
import { strings } from "../src/i18n/index.js";

const en = strings("en");
import { employerRelation } from "../src/matching/employer.js";

const history = [
  { employer: "Via", isCurrent: true },
  { employer: "Juganu Ltd.", isCurrent: false },
];

describe("employerRelation", () => {
  it("recognizes the current and former employers by whole-word company name", () => {
    expect(employerRelation("Via", history)).toEqual({ kind: "current", employer: "Via" });
    expect(employerRelation("Via Transportation, Inc.", history)).toEqual({ kind: "current", employer: "Via" });
    expect(employerRelation("JUGANU", history)).toEqual({ kind: "former", employer: "Juganu Ltd." });
    expect(employerRelation("Viasat", history)).toBeNull();
    expect(employerRelation("Wiz", history)).toBeNull();
    expect(employerRelation(null, history)).toBeNull();
  });

  it("prefers a current role when the user also worked there before", () => {
    expect(employerRelation("Via", [{ employer: "Via", isCurrent: false }, ...history])).toEqual({ kind: "current", employer: "Via" });
  });
});

describe("employer notes in messages", () => {
  const match = (relation: MatchSummary["employerRelation"]): MatchSummary => ({
    matchId: "11111111-1111-1111-1111-111111111111",
    title: "Software & Data Engineer",
    company: "Via",
    location: "Tel Aviv",
    recommendation: "stretch",
    explanation: "Builds on your work.",
    employerRelation: relation,
    connectionCount: 0,
  });

  it("flags internal roles and former employers in the list and the digest", () => {
    expect(matchListItem(en, match({ kind: "current", employer: "Via" })).text).toContain("Internal opportunity at Via</b>, where you work today");
    expect(digestView(en, [match({ kind: "former", employer: "Via" })], 0).text).toContain("You worked at Via before.");
    expect(matchListItem(en, match(null)).text).not.toMatch(/Internal opportunity|worked at/);
  });
});
