import { createHash } from "node:crypto";
import type { EmploymentType, JobSourceKind, WorkMode } from "../domain/enums.js";
import { validateCanonicalJob, type ValidationResult } from "./canonical-job.js";

export interface JobSourceDescriptor {
  key: string;
  name: string;
  kind: JobSourceKind;
  baseUrl?: string;
}

export interface RawJob<TPayload = unknown> {
  externalId?: string | null;
  sourceUrl: string;
  payload: TPayload;
}

export interface NormalizedJobFields {
  title: string;
  description: string;
  company?: string | null;
  location?: string | null;
  workMode?: WorkMode | null;
  employmentType?: EmploymentType | null;
  publishedAt?: Date | null;
}

export interface CollectContext {
  since: Date | null;
  config: Record<string, unknown>;
  fetch: typeof fetch;
  signal?: AbortSignal;
  /** Records a failure that only affects part of the source (e.g. one board) so collection can continue. */
  reportError(scope: string, error: unknown): void;
}

export interface JobSourceAdapter<TPayload = unknown> {
  readonly source: JobSourceDescriptor;
  collect(ctx: CollectContext): AsyncIterable<RawJob<TPayload>> | Iterable<RawJob<TPayload>>;
  /** Pure mapping from one raw record to job fields; return null to skip records that are not job postings. */
  normalize(raw: RawJob<TPayload>): NormalizedJobFields | null;
}

export type CanonicalizeResult = ValidationResult | { ok: "skipped" };

export function toCanonicalJob<TPayload>(
  adapter: JobSourceAdapter<TPayload>,
  raw: RawJob<TPayload>,
  collectedAt: Date,
): CanonicalizeResult {
  const fields = adapter.normalize(raw);
  if (!fields) return { ok: "skipped" };
  const source = adapter.source.key;
  return validateCanonicalJob({
    company: null,
    location: null,
    workMode: null,
    employmentType: null,
    publishedAt: null,
    ...fields,
    source,
    externalId: raw.externalId ?? null,
    sourceUrl: raw.sourceUrl,
    collectedAt,
    rawRef: { source, contentHash: contentHash(raw) },
  });
}

export function contentHash(raw: RawJob): string {
  return createHash("sha256")
    .update(stableStringify({ externalId: raw.externalId ?? null, sourceUrl: raw.sourceUrl, payload: raw.payload }))
    .digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
