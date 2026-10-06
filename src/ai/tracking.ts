export const MODEL_CALL_PURPOSES = [
  "deep_match.decide",
  "deep_match.explain",
  "cv.tailor",
  "discovery.search",
  "discovery.extract",
  "profile.extract",
  "profile.interpret",
] as const;
export type ModelCallPurpose = (typeof MODEL_CALL_PURPOSES)[number];

export interface ModelCall {
  purpose: ModelCallPurpose;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  ok: boolean;
  error: string | null;
}

export interface ModelCallRecorder {
  record(call: ModelCall): Promise<void>;
}

export const noopRecorder: ModelCallRecorder = { record: async () => undefined };

interface Usage {
  inputTokens?: number | { total?: number };
  outputTokens?: number | { total?: number };
}

/** AI Gateway tags every call by purpose and environment, so spend can be reported per purpose. */
export function gatewayOptions(purpose: ModelCallPurpose) {
  return { gateway: { tags: [`purpose:${purpose}`, `env:${process.env.VERCEL_ENV ?? "local"}`] } };
}

/**
 * Runs one model call with gateway tags and records its purpose, tokens, duration and outcome. Recording never
 * fails the call.
 */
export async function tracked<T extends { usage?: Usage; totalUsage?: Usage }>(
  recorder: ModelCallRecorder,
  purpose: ModelCallPurpose,
  model: string,
  call: (providerOptions: ReturnType<typeof gatewayOptions>) => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const record = (fields: Pick<ModelCall, "ok" | "error" | "inputTokens" | "outputTokens">) =>
    recorder
      .record({ purpose, model, durationMs: Math.round(performance.now() - startedAt), ...fields })
      .catch((error) => console.warn("model call not recorded", { purpose, error }));
  try {
    const result = await call(gatewayOptions(purpose));
    const usage = result.totalUsage ?? result.usage;
    await record({ ok: true, error: null, inputTokens: tokens(usage?.inputTokens), outputTokens: tokens(usage?.outputTokens) });
    return result;
  } catch (error) {
    await record({ ok: false, error: error instanceof Error ? error.message : String(error), inputTokens: null, outputTokens: null });
    throw error;
  }
}

function tokens(value: Usage["inputTokens"]): number | null {
  const count = typeof value === "number" ? value : value?.total;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}
