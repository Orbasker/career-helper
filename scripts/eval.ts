import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AiCvTailorer, CV_TAILORING_PROMPT_VERSION } from "../src/ai/cv-tailorer.js";
import { AiDeepMatcher, DECISION_MODEL, DEEP_MATCH_PROMPT_VERSION, EXPLANATION_MODEL } from "../src/ai/deep-matcher.js";
import { runCvEval } from "../src/cv/cv-eval.js";
import { compareToBaseline, evalSnapshot, type EvalSnapshot } from "../src/eval/compare.js";
import { runDeepMatchEval } from "../src/matching/deep-match-eval.js";

const BASELINE = "eval/baseline.json";
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};
const decisionModel = option("decision-model", DECISION_MODEL);
const explanationModel = option("explanation-model", EXPLANATION_MODEL);
const cvModel = option("cv-model", EXPLANATION_MODEL);

const matcher = new AiDeepMatcher(decisionModel, explanationModel);
const tailorer = new AiCvTailorer(cvModel);
const [matching, cv] = await Promise.all([runDeepMatchEval(matcher), runCvEval(tailorer)]);

console.log("MATCHING");
for (const { case: c, verdict, problems } of matching) {
  console.log(`${problems.length ? "FAIL" : "ok  "} ${c.group.padEnd(10)} ${c.id.padEnd(24)} ${verdict ? `${verdict.recommendation} (${verdict.confidence})` : "—"}`);
  for (const problem of problems) console.log(`     ! ${problem}`);
}
console.log("\nCV FACTUALITY");
for (const { case: c, cv: result, problems } of cv) {
  console.log(`${problems.length ? "FAIL" : "ok  "} ${c.id.padEnd(24)} ${result ? `${result.items.length} lines` : "—"}`);
  for (const problem of problems) console.log(`     ! ${problem}`);
}

const snapshot = evalSnapshot(
  {
    matching: matching.map((r) => ({ id: r.case.id, problems: r.problems })),
    cv: cv.map((r) => ({ id: r.case.id, problems: r.problems })),
  },
  {
    decisionModel,
    explanationModel,
    cvModel,
    deepMatchPrompt: DEEP_MATCH_PROMPT_VERSION,
    cvPrompt: CV_TAILORING_PROMPT_VERSION,
  },
);
const baseline = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf8")) as EvalSnapshot) : null;
const comparison = compareToBaseline(snapshot, baseline);
console.log(`\n${comparison.lines.join("\n")}`);
if (comparison.fixed.length) console.log(`Fixed: ${comparison.fixed.join(", ")}`);
if (comparison.regressions.length) console.log(`REGRESSIONS: ${comparison.regressions.join(", ")}`);

if (args.includes("--save-baseline")) {
  writeFileSync(BASELINE, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`Saved ${BASELINE}`);
} else if (comparison.regressions.length) {
  process.exitCode = 1;
}
