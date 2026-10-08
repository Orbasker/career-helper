import type { JobSourceAdapter } from "../adapter.js";
import {
  collectBoards,
  dateFrom,
  employmentTypeFrom,
  fetchJson,
  fetchText,
  htmlToText,
  workModeFrom,
  type BoardPayload,
} from "./shared.js";

export interface ComeetPosition {
  uid: string;
  name: string;
  company_name?: string | null;
  department?: string | null;
  location?: { name?: string | null; city?: string | null; country?: string | null; is_remote?: boolean | null } | null;
  workplace_type?: string | null;
  employment_type?: string | null;
  experience_level?: string | null;
  time_updated?: string | null;
  url_comeet_hosted_page?: string | null;
  url_active_page?: string | null;
  details?: { name: string; value: string | null; order?: number }[];
  [key: string]: unknown;
}

const API = "https://www.comeet.co/careers-api/2.0/company";
const CAREERS = "https://www.comeet.com/jobs";

export const comeetAdapter: JobSourceAdapter<BoardPayload<ComeetPosition>> = {
  source: { key: "comeet", name: "Comeet job boards", kind: "api", baseUrl: CAREERS },

  collect: (ctx) =>
    collectBoards(ctx, async (board) => {
      const [slug, uid] = board.token.split("/");
      if (!slug || !uid) throw new Error(`Comeet board "${board.token}" is not {slug}/{companyUid}`);
      const token = configuredApiToken(ctx.config, board.token) ?? (await apiTokenFromCareersPage(ctx, slug, uid));
      const url = `${API}/${encodeURIComponent(uid)}/positions?token=${encodeURIComponent(token)}&details=true`;
      const positions = await fetchJson<ComeetPosition[]>(ctx, url);
      return positions.map((posting) => ({
        externalId: `${board.token}:${posting.uid}`,
        sourceUrl: posting.url_active_page ?? posting.url_comeet_hosted_page ?? `${CAREERS}/${board.token}`,
        payload: { board: board.token, company: board.company, posting },
      }));
    }),

  normalize({ payload: { company, posting } }) {
    const details = [...(posting.details ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const description = details
      .map((detail) => {
        const text = htmlToText(detail.value ?? "");
        return text && `${detail.name}\n${text}`;
      })
      .filter(Boolean)
      .join("\n\n");
    const place = posting.location;
    const location = place?.name || [place?.city, place?.country].filter(Boolean).join(", ") || null;
    return {
      title: posting.name.trim(),
      description,
      company: company ?? posting.company_name ?? null,
      location,
      workMode: workModeFrom(posting.workplace_type) ?? (place?.is_remote ? "remote" : null),
      employmentType: employmentTypeFrom(posting.employment_type),
      publishedAt: dateFrom(posting.time_updated),
    };
  },
};

function configuredApiToken(config: Record<string, unknown>, token: string): string | null {
  const boards = Array.isArray(config.boards) ? config.boards : [];
  const entry = boards.find((b) => b && typeof b === "object" && b.token?.trim?.() === token);
  return typeof entry?.apiToken === "string" && entry.apiToken ? entry.apiToken : null;
}

async function apiTokenFromCareersPage(
  ctx: Parameters<typeof fetchText>[0],
  slug: string,
  uid: string,
): Promise<string> {
  const url = `${CAREERS}/${encodeURIComponent(slug)}/${encodeURIComponent(uid)}`;
  const page = await fetchText(ctx, url);
  if (!page.ok) throw new Error(`GET ${url} failed with ${page.status}`);
  const companyUid = /"company_uid":\s*"([0-9A-F]{2}\.[0-9A-F]{3})"/i.exec(page.text)?.[1];
  const token = /"token":\s*"([0-9A-F]+)"/i.exec(page.text)?.[1];
  if (!token || companyUid?.toUpperCase() !== uid.toUpperCase()) throw new Error(`No Comeet API token on ${url}`);
  return token;
}
