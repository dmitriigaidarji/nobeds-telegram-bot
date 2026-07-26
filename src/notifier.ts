import type { Bot } from "grammy";
import { GrammyError } from "grammy";

const TELEGRAM_MAX_MESSAGE = 4096;

/** Split on line boundaries where possible, hard-split only when a line is huge. */
export function chunk(text: string, limit = TELEGRAM_MAX_MESSAGE): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (line.length > limit) {
      if (current !== "") {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += limit) {
        chunks.push(line.slice(i, i + limit));
      }
      continue;
    }
    if (current === "") {
      current = line;
    } else if (current.length + 1 + line.length <= limit) {
      current += `\n${line}`;
    } else {
      chunks.push(current);
      current = line;
    }
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Telegram error codes that mean "this chat will never accept a message
 * again": the user blocked the bot, deleted the chat, or kicked it from the
 * group. Feeds belonging to such a chat are switched off rather than retried
 * forever.
 */
export function isChatGone(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  if (error.error_code !== 403 && error.error_code !== 400) return false;
  return /blocked|deactivated|kicked|chat not found|user is deactivated|bot was kicked/i.test(
    error.description,
  );
}

export class Notifier {
  constructor(private bot: Bot) {}

  /**
   * Send with retries. Telegram's 429 carries a `retry_after` we must honour;
   * anything else gets a short backoff. A booking notification is worth a few
   * retries - dropping one is the failure mode this whole bot exists to avoid.
   */
  async send(chatId: string, text: string): Promise<void> {
    for (const part of chunk(text)) {
      await this.sendOne(chatId, part);
    }
  }

  private async sendOne(
    chatId: string,
    text: string,
    attempt = 0,
  ): Promise<void> {
    try {
      await this.bot.api.sendMessage(chatId, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      if (attempt >= 4) throw error;

      let waitMs = 2000 * 2 ** attempt;
      if (error instanceof GrammyError) {
        const retryAfter = error.parameters?.retry_after;
        if (retryAfter) {
          waitMs = retryAfter * 1000 + 500;
        } else if (error.error_code >= 400 && error.error_code < 500) {
          // Bad chat id, blocked bot, malformed HTML: retrying cannot help.
          throw error;
        }
      }

      await sleep(waitMs);
      await this.sendOne(chatId, text, attempt + 1);
    }
  }
}
