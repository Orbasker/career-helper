import { AiDeepMatcher, DECISION_MODEL, EXPLANATION_MODEL } from "../src/ai/deep-matcher.js";
import { runDeepMatchEval } from "../src/matching/deep-match-eval.js";

const [decisionModel = DECISION_MODEL, explanationModel = EXPLANATION_MODEL] = process.argv.slice(2);
const matcher = new AiDeepMatcher(decisionModel, explanationModel);
const results = await runDeepMatchEval(matcher);

for (const { case: evalCase, verdict, problems } of results) {
  const status = problems.length ? "FAIL" : "ok  ";
  const got = verdict ? `${verdict.recommendation} (${verdict.confidence})` : "—";
  console.log(`${status} ${evalCase.group.padEnd(10)} ${evalCase.id.padEnd(22)} ${got}`);
  if (verdict) console.log(`     ${verdict.explanation}`);
  for (const problem of problems) console.log(`     ! ${problem}`);
}

const failed = results.filter((r) => r.problems.length).length;
console.log(`\n${matcher.model} ${matcher.promptVersion}: ${results.length - failed}/${results.length} passed`);
if (failed) process.exitCode = 1;
