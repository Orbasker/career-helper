import type { JobSourceAdapter } from "../adapter.js";
import { collectBoards, dateFrom, employmentTypeFrom, fetchJson, htmlToText, type BoardPayload } from "./shared.js";

export interface WorkableLocation {
  country?: string | null;
  countryCode?: string | null;
  city?: string | null;
  region?: string | null;
  hidden?: boolean;
}

export interface WorkableJob {
  shortcode: string;
  title: string;
  employment_type?: string | null;
  telecommuting?: boolean;
  department?: string | null;
  url?: string | null;
  shortlink?: string | null;
  published_on?: string | null;
  created_at?: string | null;
  country?: string | null;
  city?: string | null;
  locations?: WorkableLocation[];
  description?: string | null;
  [key: string]: unknown;
}

const API = "https://apply.workable.com/api/v1/widget/accounts";

export const workableAdapter: JobSourceAdapter<BoardPayload<WorkableJob>> = {
  source: { key: "workable", name: "Workable job boards", kind: "api", baseUrl: "https://apply.workable.com" },

  collect: (ctx) =>
    collectBoards(ctx, async (board) => {
      const url = `${API}/${encodeURIComponent(board.token)}?details=true`;
      const { name, jobs } = await fetchJson<{ name?: string | null; jobs: WorkableJob[] }>(ctx, url);
      return jobs.map((posting) => ({
        externalId: `${board.token}:${posting.shortcode}`,
        sourceUrl: `https://apply.workable.com/${encodeURIComponent(board.token)}/j/${posting.shortcode}/`,
        payload: { board: board.token, company: board.company ?? name ?? null, posting },
      }));
    }),

  normalize({ payload: { company, posting } }) {
    const places = (posting.locations ?? []).filter((l) => !l.hidden);
    const first = places[0] ?? { city: posting.city, country: posting.country };
    const location = [first.city, first.country].filter(Boolean).join(", ") || null;
    return {
      title: posting.title.trim(),
      description: htmlToText(posting.description ?? ""),
      company,
      location,
      workMode: posting.telecommuting ? "remote" : null,
      employmentType: employmentTypeFrom(posting.employment_type),
      publishedAt: dateFrom(posting.published_on ?? posting.created_at),
    };
  },
};
