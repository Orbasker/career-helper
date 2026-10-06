import type { JobSourceAdapter } from "../adapter.js";
import { collectBoards, dateFrom, employmentTypeFrom, fetchJson, htmlToText, tidyText, workModeFrom, type BoardPayload } from "./shared.js";

export interface AshbyPosting {
  id: string;
  title: string;
  jobUrl: string;
  location?: string | null;
  employmentType?: string | null;
  workplaceType?: string | null;
  isRemote?: boolean | null;
  isListed?: boolean;
  publishedAt?: string | null;
  descriptionHtml?: string | null;
  descriptionPlain?: string | null;
  [key: string]: unknown;
}

const API = "https://api.ashbyhq.com/posting-api/job-board";

export const ashbyAdapter: JobSourceAdapter<BoardPayload<AshbyPosting>> = {
  source: { key: "ashby", name: "Ashby job boards", kind: "api", baseUrl: API },

  collect: (ctx) =>
    collectBoards(ctx, async (board) => {
      const url = `${API}/${encodeURIComponent(board.token)}?includeCompensation=true`;
      const { jobs } = await fetchJson<{ jobs: AshbyPosting[] }>(ctx, url);
      return jobs.map((posting) => ({
        externalId: `${board.token}:${posting.id}`,
        sourceUrl: posting.jobUrl,
        payload: { board: board.token, company: board.company, posting },
      }));
    }),

  normalize({ payload: { company, posting } }) {
    if (posting.isListed === false) return null;
    return {
      title: posting.title,
      description: tidyText(posting.descriptionPlain ?? "") || htmlToText(posting.descriptionHtml ?? ""),
      company,
      location: posting.location ?? null,
      workMode: workModeFrom(posting.workplaceType) ?? (posting.isRemote ? "remote" : null),
      employmentType: employmentTypeFrom(posting.employmentType),
      publishedAt: dateFrom(posting.publishedAt),
    };
  },
};
