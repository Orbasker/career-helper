export interface NormalizedJobKey {
  normalizedTitle: string | null;
  normalizedCompany: string | null;
  normalizedLocation: string | null;
}

export const TITLE_ABBREVIATIONS: Record<string, string> = {
  sr: "senior",
  snr: "senior",
  jr: "junior",
  mgr: "manager",
  hr: "human resources",
  vp: "vice president",
  svp: "senior vice president",
  evp: "executive vice president",
  swe: "software engineer",
};

const TITLE_NOISE = [
  /\((?:[mfwdx]\s*\/\s*)+[mfwdx]\)/gi,
  /\s[-–|]\s*(?:remote|hybrid|on-?site)\b.*$/i,
  /\((?:remote|hybrid|on-?site)[^)]*\)/gi,
];

const COMPANY_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "llp",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "plc",
  "gmbh",
  "ag",
  "sa",
  "sas",
  "bv",
  "nv",
  "oy",
  "ab",
  "pty",
  "pte",
  "srl",
]);

const LOCATION_ALIASES: Record<string, string> = {
  "tel aviv yafo": "tel aviv",
  "tel aviv jaffa": "tel aviv",
  tlv: "tel aviv",
  nyc: "new york",
  "new york city": "new york",
  sf: "san francisco",
  "san francisco bay area": "san francisco",
  "bay area": "san francisco",
  "remote first": "remote",
  anywhere: "remote",
  "work from home": "remote",
  wfh: "remote",
  "עבודה מהבית": "remote",
  ישראל: "israel",
  "תל אביב": "tel aviv",
  "תל אביב יפו": "tel aviv",
  ירושלים: "jerusalem",
  חיפה: "haifa",
  הרצליה: "herzliya",
  רעננה: "raanana",
  "פתח תקווה": "petah tikva",
  "פתח תקוה": "petah tikva",
  "רמת גן": "ramat gan",
  גבעתיים: "givatayim",
  "בני ברק": "bnei brak",
  חולון: "holon",
  "בת ים": "bat yam",
  "ראשון לציון": "rishon lezion",
  רחובות: "rehovot",
  "נס ציונה": "ness ziona",
  נתניה: "netanya",
  "כפר סבא": "kfar saba",
  "הוד השרון": "hod hasharon",
  "ראש העין": "rosh haayin",
  "אור יהודה": "or yehuda",
  יהוד: "yehud",
  מודיעין: "modiin",
  לוד: "lod",
  רמלה: "ramla",
  אשדוד: "ashdod",
  אשקלון: "ashkelon",
  "באר שבע": "beer sheva",
  יקנעם: "yokneam",
  "יקנעם עילית": "yokneam",
  "קיסריה": "caesarea",
  "רמת השרון": "ramat hasharon",
  "ראש פינה": "rosh pina",
};

export function normalizeTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const stripped = TITLE_NOISE.reduce((text, pattern) => text.replace(pattern, " "), title);
  const words = simplify(stripped)
    .split(" ")
    .map((word) => TITLE_ABBREVIATIONS[word] ?? word);
  return nonEmpty(words.join(" "));
}

export function normalizeCompany(company: string | null | undefined): string | null {
  if (!company) return null;
  const words = simplify(company.replace(/\b([a-z])\.(?=[a-z]\.)/gi, "$1")).split(" ");
  while (words.length > 1 && COMPANY_SUFFIXES.has(words.at(-1)!)) words.pop();
  return nonEmpty(words.join(" "));
}

/** Reduces a location to its primary place, e.g. "Tel Aviv-Yafo, Israel; London" → "tel aviv". */
export function normalizeLocation(location: string | null | undefined): string | null {
  if (!location) return null;
  const primary = location.split(/[;|•/]/)[0]!.split(",")[0]!;
  const place = simplify(primary);
  return nonEmpty(LOCATION_ALIASES[place] ?? place);
}

export function normalizeJobKey(job: {
  title: string;
  company: string | null;
  location: string | null;
}): NormalizedJobKey {
  return {
    normalizedTitle: normalizeTitle(job.title),
    normalizedCompany: normalizeCompany(job.company),
    normalizedLocation: normalizeLocation(job.location),
  };
}

/** Deterministic duplicate key; null when there is no company to scope it to. */
export function dedupKey(key: NormalizedJobKey): string | null {
  if (!key.normalizedTitle || !key.normalizedCompany) return null;
  return [key.normalizedTitle, key.normalizedCompany, key.normalizedLocation ?? ""].join("|");
}

export function normalizeText(text: string): string {
  return simplify(text);
}

export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (!a.size && !b.size) return 1;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return shared / (a.size + b.size - shared);
}

export function wordShingles(text: string, size = 3): Set<string> {
  const words = normalizeText(text).split(" ").filter(Boolean);
  if (words.length <= size) return new Set(words.length ? [words.join(" ")] : []);
  const shingles = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) shingles.add(words.slice(i, i + size).join(" "));
  return shingles;
}

function simplify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function nonEmpty(text: string): string | null {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed === "" ? null : trimmed;
}
