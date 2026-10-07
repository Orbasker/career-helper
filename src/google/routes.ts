import type { GmailConnectOutcome, GmailService } from "../app/services.js";
import { escapeHtml } from "../bot/views.js";
import type { ConversationLanguage } from "../domain/enums.js";
import { strings, type Strings } from "../i18n/index.js";

export type SendTelegramMessage = (chatId: number, html: string) => Promise<unknown>;

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

function page(language: ConversationLanguage | null, title: string | null, body: string, status = 200): Response {
  const lang = language ?? "en";
  const html = `<!doctype html><html lang="${lang}" dir="${lang === "he" ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title ?? "Career Agent")}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style></head><body>${title ? `<h1>${escapeHtml(title)}</h1>` : ""}<p>${escapeHtml(body)}</p></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE } });
}

const expiredPage = (t: Strings) => page(null, null, t.gmail.page.expired, 400);

/** `GET /api/google/connect?state=…`: the link sent in Telegram; redirects to Google sign-in while the state is pending. */
export function createGoogleConnectHandler(gmail: GmailService): (request: Request) => Promise<Response> {
  return async (request) => {
    const state = new URL(request.url).searchParams.get("state");
    const url = state ? await gmail.authorizationUrl(state) : null;
    if (!url) return expiredPage(strings(null));
    return new Response(null, { status: 302, headers: { location: url, ...NO_STORE } });
  };
}

function telegramText(t: Strings, outcome: Exclude<GmailConnectOutcome, { kind: "invalid_state" }>): string {
  switch (outcome.kind) {
    case "connected":
      return t.gmail.connected(escapeHtml(outcome.email));
    case "denied":
      return t.gmail.denied;
    case "missing_scope":
      return t.gmail.missingScope;
    case "failed":
      return t.gmail.failed;
  }
}

/** `GET /api/google/callback`: finishes sign-in, tells the user in Telegram and shows a page to return there. */
export function createGoogleCallbackHandler(gmail: GmailService, send: SendTelegramMessage): (request: Request) => Promise<Response> {
  return async (request) => {
    const params = new URL(request.url).searchParams;
    const state = params.get("state");
    if (!state) return expiredPage(strings(null));
    const outcome = await gmail.completeConnect({ state, code: params.get("code"), error: params.get("error") });
    if (outcome.kind === "invalid_state") return expiredPage(strings(null));

    const t = strings(outcome.language);
    const text = telegramText(t, outcome);
    await send(outcome.chatId, text).catch((error: unknown) => console.error("gmail connection message failed", { error }));
    const title = outcome.kind === "connected" ? t.gmail.page.connected : outcome.kind === "denied" ? t.gmail.page.denied : t.gmail.page.failed;
    return page(outcome.language, title, t.gmail.page.backToTelegram);
  };
}
