export interface SuiteSnapshot {
  passed: number;
  total: number;
  failing: string[];
}

export interface EvalSnapshot {
  createdAt: string;
  models: Record<string, string>;
  suites: Record<string, SuiteSnapshot>;
}

export interface EvalComparison {
  /** Cases that passed in the baseline and fail now, as `suite/case`. */
  regressions: string[];
  /** Cases that failed in the baseline and pass now. */
  fixed: string[];
  lines: string[];
}

export function evalSnapshot(
  results: Record<string, readonly { id: string; problems: readonly string[] }[]>,
  models: Record<string, string>,
  now = new Date(),
): EvalSnapshot {
  const suites = Object.fromEntries(
    Object.entries(results).map(([suite, cases]) => {
      const failing = cases.filter((c) => c.problems.length > 0).map((c) => c.id);
      return [suite, { passed: cases.length - failing.length, total: cases.length, failing }];
    }),
  );
  return { createdAt: now.toISOString(), models, suites };
}

/** Pass rates per suite against the baseline, and which cases regressed or got fixed. */
export function compareToBaseline(current: EvalSnapshot, baseline: EvalSnapshot | null): EvalComparison {
  const regressions: string[] = [];
  const fixed: string[] = [];
  const lines: string[] = [];
  for (const [suite, now] of Object.entries(current.suites)) {
    const before = baseline?.suites[suite];
    const rate = `${now.passed}/${now.total}`;
    if (!before) {
      lines.push(`${suite}: ${rate} (no baseline)`);
      continue;
    }
    const wasFailing = new Set(before.failing);
    const isFailing = new Set(now.failing);
    for (const id of now.failing) if (!wasFailing.has(id)) regressions.push(`${suite}/${id}`);
    for (const id of before.failing) if (!isFailing.has(id)) fixed.push(`${suite}/${id}`);
    lines.push(`${suite}: ${rate} (baseline ${before.passed}/${before.total})`);
  }
  if (baseline) {
    const changed = Object.entries(current.models).filter(([key, model]) => baseline.models[key] !== model);
    for (const [key, model] of changed) lines.push(`${key}: ${baseline.models[key] ?? "—"} → ${model}`);
  }
  return { regressions, fixed, lines };
}
