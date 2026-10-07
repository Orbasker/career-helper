import { Api, GrammyError, HttpError } from "grammy";
import type { MatchSummary } from "../app/services.js";
import type { ConversationLanguage } from "../domain/enums.js";
import { strings } from "../i18n/index.js";
import { RecipientUnavailableError, type Notifier } from "../pipeline/notify.js";
import { digestView } from "./views.js";

export interface TelegramNotifierOptions {
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const UNAVAILABLE_CHAT = /bot was blocked|user is deactivated|chat not found|bot can't initiate/i;

export class TelegramNotifier implements Notifier {
  private readonly attempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly api: Api,
    options: TelegramNotifierOptions = {},
  ) {
    this.attempts = options.attempts ?? 3;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async sendDigest(
    chatId: number,
    matches: MatchSummary[],
    remaining: number,
    language: ConversationLanguage | null,
  ): Promise<void> {
    const view = digestView(strings(language), matches, remaining);
    const send = () =>
      this.api.sendMessage(chatId, view.text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: view.keyboard,
      });

    for (let attempt = 1; ; attempt++) {
      try {
        await send();
        return;
      } catch (error) {
        if (error instanceof GrammyError && (error.error_code === 403 || UNAVAILABLE_CHAT.test(error.description))) {
          throw new RecipientUnavailableError(error.description);
        }
        const delayMs = retryDelayMs(error, attempt);
        if (delayMs === null || attempt >= this.attempts) throw error;
        await this.sleep(delayMs);
      }
    }
  }
}

function retryDelayMs(error: unknown, attempt: number): number | null {
  if (error instanceof HttpError) return 1000 * attempt;
  if (!(error instanceof GrammyError)) return null;
  if (error.error_code === 429) return (error.parameters.retry_after ?? 1) * 1000;
  if (error.error_code >= 500) return 1000 * attempt;
  return null;
}
