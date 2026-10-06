const PARTIAL_DATE = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/;

export function normalizeDate(value: string | null | undefined): string | null {
  const match = value?.trim().match(PARTIAL_DATE);
  if (!match) return null;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : 1;
  const day = match[3] ? Number(match[3]) : 1;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export function formatMonth(value: string | null): string | null {
  return value ? value.slice(0, 7) : null;
}
