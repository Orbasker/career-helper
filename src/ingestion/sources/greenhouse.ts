import type { JobSourceAdapter } from "../adapter.js";
import { collectBoards, dateFrom, decodeEntities, fetchJson, htmlToText, workModeFrom, type BoardPayload } from "./shared.js";

export interface GreenhousePosting {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  first_published?: string | null;
  company_name?: string | null;
  location?: { name?: string | null } | null;
  content?: string | null;
  [key: string]: unknown;
}

const API = "https://boards-api.greenhouse.io/v1/boards";

export const greenhouseAdapter: JobSourceAdapter<BoardPayload<GreenhousePosting>> = {
  source: { key: "greenhouse", name: "Greenhouse job boards", kind: "api", baseUrl: API },

  collect: (ctx) =>
    collectBoards(ctx, async (board) => {
      const url = `${API}/${encodeURIComponent(board.token)}/jobs?content=true`;
      const { jobs } = await fetchJson<{ jobs: GreenhousePosting[] }>(ctx, url);
      return jobs.map((posting) => ({
        externalId: `${board.token}:${posting.id}`,
        sourceUrl: posting.absolute_url,
        payload: { board: board.token, company: board.company, posting },
      }));
    }),

  normalize({ payload: { company, posting } }) {
    const location = posting.location?.name ?? null;
    return {
      title: posting.title,
      description: htmlToText(decodeEntities(posting.content ?? "")),
      company: company ?? posting.company_name ?? null,
      location,
      workMode: workModeFrom(location),
      publishedAt: dateFrom(posting.first_published ?? posting.updated_at),
    };
  },
};
