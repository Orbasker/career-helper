import JSZip from "jszip";

export interface ParsedConnection {
  fullName: string;
  profileUrl: string | null;
  company: string | null;
  position: string | null;
  connectedOn: string | null;
}

export interface ParsedConnections {
  connections: ParsedConnection[];
  /** Rows that could not be read, e.g. without a name. */
  skipped: number;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** Reads LinkedIn's Connections.csv, or the export ZIP that contains it; null when it isn't a connections export. */
export async function readConnectionsFile(data: Uint8Array, fileName: string | null): Promise<ParsedConnections | null> {
  const isZip = data[0] === 0x50 && data[1] === 0x4b;
  if (isZip) {
    const zip = await JSZip.loadAsync(data);
    const entry = Object.values(zip.files).find((f) => !f.dir && /(^|\/)connections\.csv$/i.test(f.name));
    return entry ? parseConnectionsCsv(await entry.async("string")) : null;
  }
  if (fileName && !/\.csv$/i.test(fileName)) return null;
  return parseConnectionsCsv(new TextDecoder().decode(data));
}

/** Parses the CSV, skipping LinkedIn's note lines before the `First Name,Last Name,…` header. */
export function parseConnectionsCsv(text: string): ParsedConnections | null {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const headerIndex = rows.findIndex((row) => row.some((c) => c.trim().toLowerCase() === "first name"));
  if (headerIndex < 0) return null;
  const header = rows[headerIndex]!.map((c) => c.trim().toLowerCase());
  const column = (name: string) => header.indexOf(name);
  const [first, last, url, company, position, connected] = [
    "first name",
    "last name",
    "url",
    "company",
    "position",
    "connected on",
  ].map(column);

  const result: ParsedConnections = { connections: [], skipped: 0 };
  for (const row of rows.slice(headerIndex + 1)) {
    if (row.every((c) => !c.trim())) continue;
    const cell = (index: number | undefined) => (index !== undefined && index >= 0 ? row[index]?.trim() || null : null);
    const fullName = [cell(first), cell(last)].filter(Boolean).join(" ");
    if (!fullName) {
      result.skipped++;
      continue;
    }
    const profileUrl = cell(url);
    result.connections.push({
      fullName,
      profileUrl: profileUrl && /^https?:\/\//i.test(profileUrl) ? profileUrl : null,
      company: cell(company),
      position: cell(position),
      connectedOn: parseConnectedOn(cell(connected)),
    });
  }
  return result;
}

/** LinkedIn writes dates as `06 Oct 2026`; ISO dates are accepted too. */
export function parseConnectedOn(value: string | null): string | null {
  if (!value) return null;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return value;
  const match = value.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-](\d{4})$/);
  const month = match && MONTHS[match[2]!.toLowerCase()];
  return match && month ? `${match[3]}-${month}-${match[1]!.padStart(2, "0")}` : null;
}

/** RFC 4180 CSV: quoted fields may contain commas, newlines and doubled quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}
