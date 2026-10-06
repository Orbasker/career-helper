import { EMPLOYMENT_TYPES, WORK_MODES, type EmploymentType, type WorkMode } from "../domain/enums.js";

export interface RawRecordRef {
  source: string;
  contentHash: string;
}

export interface CanonicalJob {
  source: string;
  externalId: string | null;
  sourceUrl: string;
  title: string;
  company: string | null;
  description: string;
  location: string | null;
  workMode: WorkMode | null;
  employmentType: EmploymentType | null;
  publishedAt: Date | null;
  collectedAt: Date;
  rawRef: RawRecordRef;
}

export type CanonicalJobInput = {
  [K in keyof CanonicalJob]: K extends "rawRef" ? RawRecordRef : unknown;
};

export type ValidationResult = { ok: true; job: CanonicalJob } | { ok: false; issues: string[] };

export function validateCanonicalJob(input: CanonicalJobInput): ValidationResult {
  const issues: string[] = [];

  const required = (field: string, value: unknown) => {
    const text = optionalText(value);
    if (text === null) issues.push(`${field} is required`);
    return text ?? "";
  };
  const oneOf = <T extends string>(field: string, value: unknown, allowed: readonly T[]): T | null => {
    if (value === null || value === undefined) return null;
    if (allowed.includes(value as T)) return value as T;
    issues.push(`${field} must be one of ${allowed.join(", ")}`);
    return null;
  };
  const date = (field: string, value: unknown) => {
    if (value === null || value === undefined) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    issues.push(`${field} must be a valid Date`);
    return null;
  };

  const sourceUrl = required("sourceUrl", input.sourceUrl);
  if (sourceUrl && !isHttpUrl(sourceUrl)) issues.push("sourceUrl must be an http(s) URL");
  const collectedAt = date("collectedAt", input.collectedAt);
  if (!collectedAt) issues.push("collectedAt is required");
  if (!input.rawRef?.source || !input.rawRef.contentHash) issues.push("rawRef is required");

  const job: CanonicalJob = {
    source: required("source", input.source),
    externalId: optionalText(input.externalId),
    sourceUrl,
    title: required("title", input.title),
    company: optionalText(input.company),
    description: required("description", input.description),
    location: optionalText(input.location),
    workMode: oneOf("workMode", input.workMode, WORK_MODES),
    employmentType: oneOf("employmentType", input.employmentType, EMPLOYMENT_TYPES),
    publishedAt: date("publishedAt", input.publishedAt),
    collectedAt: collectedAt ?? new Date(NaN),
    rawRef: input.rawRef,
  };
  if (input.rawRef && job.source && input.rawRef.source !== job.source) issues.push("rawRef.source must match source");

  return issues.length ? { ok: false, issues } : { ok: true, job };
}

function optionalText(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
