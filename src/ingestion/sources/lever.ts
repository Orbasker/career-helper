import type { JobSourceAdapter } from "../adapter.js";
import { collectBoards, dateFrom, employmentTypeFrom, fetchJson, htmlToText, tidyText, workModeFrom, type BoardPayload } from "./shared.js";

export interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  workplaceType?: string | null;
  categories?: { commitment?: string; location?: string; team?: string; department?: string };
  description?: string | null;
  descriptionPlain?: string | null;
  lists?: { text: string; content: string }[];
  additional?: string | null;
  additionalPlain?: string | null;
  [key: string]: unknown;
}

const API = "https://api.lever.co/v0/postings";

export const leverAdapter: JobSourceAdapter<BoardPayload<LeverPosting>> = {
  source: { key: "lever", name: "Lever job boards", kind: "api", baseUrl: API },

  collect: (ctx) =>
    collectBoards(ctx, async (board) => {
      const url = `${API}/${encodeURIComponent(board.token)}?mode=json`;
      const postings = await fetchJson<LeverPosting[]>(ctx, url);
      return postings.map((posting) => ({
        externalId: `${board.token}:${posting.id}`,
        sourceUrl: posting.hostedUrl,
        payload: { board: board.token, company: board.company, posting },
      }));
    }),

  normalize({ payload: { company, posting } }) {
    const sections = [
      tidyText(posting.descriptionPlain ?? "") || htmlToText(posting.description ?? ""),
      ...(posting.lists ?? []).map((list) => `${list.text}\n${htmlToText(list.content)}`),
      tidyText(posting.additionalPlain ?? "") || htmlToText(posting.additional ?? ""),
    ];
    const location = posting.categories?.location ?? null;
    return {
      title: posting.text,
      description: sections.map((s) => s.trim()).filter(Boolean).join("\n\n"),
      company,
      location,
      workMode: workModeFrom(posting.workplaceType) ?? workModeFrom(location),
      employmentType: employmentTypeFrom(posting.categories?.commitment),
      publishedAt: dateFrom(posting.createdAt),
    };
  },
};
