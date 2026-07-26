/**
 * The Telegram side.
 *
 * The bot is multi-tenant and self-service: any chat can send its own NoBeds
 * iCal export link, and that chat then gets that link's notifications. Nothing
 * is configured per-chat in the environment, and there is no owner check - the
 * only thing a chat can reach is the set of links it added itself.
 */

import { Bot } from "grammy";
import type { Context } from "grammy";
import type { Config } from "./config.ts";
import { maskUrl } from "./config.ts";
import type { Feed, FeedStore, SnapshotStore } from "./store.ts";
import { escapeHtml, formatAvailability, formatUpcoming } from "./format.ts";
import { buildAvailability } from "./availability.ts";
import { loadBookings, registerFeed } from "./feeds.ts";
import { inspectToken } from "./token.ts";
import { todayIso } from "./booking.ts";
import type { BookingDetails } from "./booking.ts";
import type { PollOutcome } from "./poller.ts";

const UPCOMING_LIMIT = 10;

/** Any http(s) link in a message, so a pasted URL works without a command. */
const URL_IN_TEXT = /\bhttps?:\/\/\S+/i;

function humanAge(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/** `ctx.msg` rather than `ctx.message`, so channel posts work the same way. */
function commandArgs(ctx: Context): string {
  const text = ctx.msg?.text ?? "";
  const space = text.indexOf(" ");
  return space === -1 ? "" : text.slice(space + 1).trim();
}

const HELP = [
  "<b>Commands</b>",
  "/add — watch another iCal link",
  "/list — links this chat watches",
  "/remove — stop watching one (or <code>all</code>)",
  "/availability — what's free, and when",
  "/upcoming — the next arrivals",
  "/poll — check the feeds right now",
  "/status — feed health and link expiry",
  "/help — this message",
].join("\n");

export interface BotHooks {
  /** Poll a freshly added feed immediately instead of waiting for the tick. */
  onFeedAdded?: (feedId: number) => void;
  /**
   * Poll the given feeds now and resolve once done. The implementation must
   * serialise against the scheduled loop: two polls of one feed running at the
   * same time would diff against the same snapshot and notify twice.
   */
  pollNow?: (feedIds: number[]) => Promise<PollOutcome[]>;
}

/**
 * Minimum spacing between manual polls in one chat. The scheduled interval is
 * already at least 60s; this exists so /poll can't be held down as a way of
 * hammering someone else's server.
 */
const MANUAL_POLL_COOLDOWN_MS = 30_000;

export function createBot(
  config: Config,
  store: FeedStore,
  snapshots: SnapshotStore,
  hooks: BotHooks = {},
): Bot {
  const bot = new Bot(config.botToken);

  /** Chats that were asked for a link and haven't sent one yet. */
  const awaitingLink = new Set<string>();

  /** Chat id -> timestamp of its last manual /poll, for the cooldown. */
  const lastManualPoll = new Map<string, number>();

  const chatIdOf = (ctx: Context): string => String(ctx.chat?.id ?? "");

  const askForLink = (ctx: Context): string[] => {
    awaitingLink.add(chatIdOf(ctx));
    const lines = [
      "Send me your <b>iCal export link</b> and I'll start watching it.",
      "",
      "In NoBeds: <b>Channels → iCal Export</b>, copy the “all bookings” URL, and paste it here.",
    ];
    if (ctx.chat?.type !== "private") {
      lines.push(
        "",
        "⚠️ Everyone in this group will see the link, and it grants read access to your bookings. A private chat with me is the safer place to paste it.",
      );
    }
    return lines;
  };

  const listFeeds = (chatId: string): Feed[] => store.feedsForChat(chatId);

  async function handleLink(ctx: Context, rawUrl: string): Promise<void> {
    const chatId = chatIdOf(ctx);
    await ctx.replyWithChatAction("typing").catch(() => {});

    const result = await registerFeed(store, config, chatId, rawUrl);
    if (!result.ok) {
      await ctx.reply(`⚠️ ${result.reason}`, { parse_mode: "HTML" });
      return;
    }

    awaitingLink.delete(chatId);

    if (result.alreadyWatching) {
      await ctx.reply(
        `I'm already watching that link (<code>${escapeHtml(maskUrl(result.feed.url))}</code>). Use /list to see everything, or /availability for what's free.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    const rooms =
      result.rooms.length > 0
        ? `\nRooms seen: ${escapeHtml(result.rooms.join(", "))}`
        : "";
    await ctx.reply(
      [
        "✅ <b>Link added.</b>",
        "",
        `<code>${escapeHtml(maskUrl(result.feed.url))}</code>`,
        `Bookings in the feed right now: <b>${result.bookings}</b>${rooms}`,
        "",
        `I'll check every ${Math.round(config.pollIntervalMs / 1000 / 60)} min and message you when a booking is created, changed, or cancelled.`,
        "",
        "Try /availability or /upcoming.",
      ].join("\n"),
      { parse_mode: "HTML" },
    );

    hooks.onFeedAdded?.(result.feed.id);
  }

  bot.command("start", async (ctx) => {
    const feeds = listFeeds(chatIdOf(ctx));
    const lines = ["👋 <b>NoBeds booking notifier</b>", ""];

    if (feeds.length === 0) {
      lines.push(...askForLink(ctx));
    } else {
      lines.push(
        `Already watching <b>${feeds.length}</b> link(s) for this chat.`,
        "",
        HELP,
        "",
        "Send another link any time to add it.",
      );
      awaitingLink.add(chatIdOf(ctx));
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP, { parse_mode: "HTML" });
  });

  bot.command("chatid", async (ctx) => {
    await ctx.reply(
      `This chat's id is <code>${escapeHtml(chatIdOf(ctx))}</code>.`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("add", async (ctx) => {
    const argument = commandArgs(ctx);
    if (argument === "") {
      await ctx.reply(askForLink(ctx).join("\n"), { parse_mode: "HTML" });
      return;
    }
    await handleLink(ctx, argument);
  });

  bot.command("list", async (ctx) => {
    const feeds = listFeeds(chatIdOf(ctx));
    if (feeds.length === 0) {
      await ctx.reply(
        ["No links yet.", "", ...askForLink(ctx)].join("\n"),
        { parse_mode: "HTML" },
      );
      return;
    }

    const lines = ["🔗 <b>Links this chat watches</b>", ""];
    feeds.forEach((feed, index) => {
      const state = snapshots.state(feed.id);
      const health = feed.disabled
        ? " · ⏸ paused"
        : state.failureCount > 0
          ? ` · ⚠️ ${state.failureCount} failure(s)`
          : "";
      lines.push(
        `${index + 1}. <code>${escapeHtml(maskUrl(feed.url))}</code>`,
        `   ${snapshots.countEventsForFeed(feed.id)} booking(s) at last poll${health}`,
      );
    });
    lines.push("", "Remove one with <code>/remove 1</code>.");

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("remove", async (ctx) => {
    const chatId = chatIdOf(ctx);
    const feeds = listFeeds(chatId);
    const argument = commandArgs(ctx).toLowerCase();

    if (feeds.length === 0) {
      await ctx.reply("This chat isn't watching any links.");
      return;
    }

    if (argument === "all") {
      const removed = store.removeFeedsForChat(chatId);
      for (const feed of removed) snapshots.forgetFeed(feed.id);
      await ctx.reply(
        `🗑 Removed ${removed.length} link(s), and dropped everything I had cached about them. You won't get any more booking notifications here. /start to set it up again.`,
      );
      return;
    }

    const index = Number.parseInt(argument, 10);
    if (!Number.isInteger(index) || index < 1 || index > feeds.length) {
      await ctx.reply(
        `Which one? Send <code>/remove 1</code> … <code>/remove ${feeds.length}</code> (see /list), or <code>/remove all</code>.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    const feed = feeds[index - 1]!;
    store.removeFeed(feed.id);
    snapshots.forgetFeed(feed.id);
    await ctx.reply(
      `🗑 Stopped watching <code>${escapeHtml(maskUrl(feed.url))}</code>.`,
      { parse_mode: "HTML" },
    );
  });

  /**
   * Force a poll now rather than waiting out the interval.
   *
   * Any booking that changed is announced by the poller itself, in the normal
   * notification format, before this reply lands - so the reply is a summary of
   * what happened, not a substitute for it.
   */
  bot.command(["poll", "refresh"], async (ctx) => {
    const chatId = chatIdOf(ctx);
    const feeds = listFeeds(chatId).filter((feed) => !feed.disabled);

    if (feeds.length === 0) {
      await ctx.reply(["No links to check.", "", ...askForLink(ctx)].join("\n"), {
        parse_mode: "HTML",
      });
      return;
    }

    if (!hooks.pollNow) {
      await ctx.reply("Polling isn't available in this process.");
      return;
    }

    const now = Date.now();
    const last = lastManualPoll.get(chatId) ?? 0;
    const waitMs = last + MANUAL_POLL_COOLDOWN_MS - now;
    if (waitMs > 0) {
      await ctx.reply(
        `⏳ Just checked. Try again in ${Math.ceil(waitMs / 1000)}s.`,
      );
      return;
    }
    lastManualPoll.set(chatId, now);

    await ctx.replyWithChatAction("typing").catch(() => {});
    const started = Date.now();

    let outcomes: PollOutcome[];
    try {
      outcomes = await hooks.pollNow(feeds.map((feed) => feed.id));
    } catch (error) {
      // Let the next attempt happen immediately: nothing was polled.
      lastManualPoll.delete(chatId);
      await ctx.reply(
        `⚠️ The check failed: <code>${escapeHtml(
          (error instanceof Error ? error.message : String(error)).slice(0, 300),
        )}</code>`,
        { parse_mode: "HTML" },
      );
      return;
    }

    const totals = outcomes.reduce(
      (sum, outcome) => ({
        created: sum.created + outcome.created,
        modified: sum.modified + outcome.modified,
        cancelled: sum.cancelled + outcome.cancelled,
      }),
      { created: 0, modified: 0, cancelled: 0 },
    );
    const failed = outcomes.filter((outcome) => outcome.status === "failed");
    const seeded = outcomes.filter((outcome) => outcome.status === "seeded");
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    const lines = [
      `🔄 <b>Checked ${feeds.length} link(s)</b> in ${seconds}s`,
      "",
    ];

    const changes = totals.created + totals.modified + totals.cancelled;
    if (changes > 0) {
      lines.push(
        `🆕 ${totals.created} new · ✏️ ${totals.modified} changed · ❌ ${totals.cancelled} cancelled`,
        "",
        "<i>The details are in the messages above.</i>",
      );
    } else if (seeded.length > 0) {
      lines.push("Adopted the current bookings. Changes from here get reported.");
    } else {
      lines.push("Nothing has changed since the last check.");
    }

    if (failed.length > 0) {
      lines.push(
        "",
        `⚠️ ${failed.length} link(s) couldn't be read: <code>${escapeHtml(
          (failed[0]!.detail ?? "unknown").slice(0, 200),
        )}</code>`,
      );
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("status", async (ctx) => {
    const feeds = listFeeds(chatIdOf(ctx));
    if (feeds.length === 0) {
      await ctx.reply(
        ["Nothing to report yet.", "", ...askForLink(ctx)].join("\n"),
        { parse_mode: "HTML" },
      );
      return;
    }

    const lines = ["📊 <b>Status</b>", ""];
    feeds.forEach((feed, index) => {
      const token = inspectToken(feed.url);
      const state = snapshots.state(feed.id);
      lines.push(
        `<b>${index + 1}. ${escapeHtml(maskUrl(feed.url))}</b>`,
        `   Bookings at last poll: <b>${snapshots.countEventsForFeed(feed.id)}</b>`,
        `   Last poll: ${humanAge(state.lastPollAt)} · last success: ${humanAge(state.lastSuccessAt)}`,
        `   Last change seen: ${humanAge(state.lastChangeAt)}`,
      );
      if (feed.disabled) {
        lines.push("   ⏸ paused (I couldn't message this chat)");
      } else if (state.failureCount > 0) {
        lines.push(
          `   ⚠️ ${state.failureCount} consecutive failure(s): ${escapeHtml(
            (state.lastError ?? "unknown").slice(0, 200),
          )}`,
        );
      } else {
        lines.push("   Feed health: ✅ ok");
      }
      if (token) {
        const marker = token.daysRemaining <= 30 ? "⚠️ " : "";
        lines.push(
          `   ${marker}Link expires: ${token.expiresAt.toISOString().slice(0, 10)} (${token.daysRemaining} days)`,
        );
      }
      lines.push("");
    });
    lines.push(`Polling every ${Math.round(config.pollIntervalMs / 1000)}s.`);

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  /**
   * Both read-only commands answer from a live fetch rather than from the
   * snapshot: always current, works before the first poll, and needs nothing
   * on disk. `failed` is reported rather than silently returning a short list.
   */
  async function bookingsFor(
    ctx: Context,
  ): Promise<{ bookings: BookingDetails[]; warning: string } | undefined> {
    const feeds = listFeeds(chatIdOf(ctx));
    if (feeds.length === 0) {
      await ctx.reply(["No links yet.", "", ...askForLink(ctx)].join("\n"), {
        parse_mode: "HTML",
      });
      return undefined;
    }

    await ctx.replyWithChatAction("typing").catch(() => {});
    const { bookings, failed } = await loadBookings(feeds);

    if (failed.length === feeds.length) {
      await ctx.reply(
        `⚠️ I couldn't reach ${failed.length === 1 ? "the feed" : "any of the feeds"} just now:\n\n<code>${escapeHtml(
          failed[0]!.reason.slice(0, 300),
        )}</code>`,
        { parse_mode: "HTML" },
      );
      return undefined;
    }

    return {
      bookings,
      warning:
        failed.length > 0
          ? `\n\n<i>⚠️ ${failed.length} of ${feeds.length} links couldn't be read just now, so this may be incomplete.</i>`
          : "",
    };
  }

  bot.command("upcoming", async (ctx) => {
    const loaded = await bookingsFor(ctx);
    if (!loaded) return;

    const requested = Number.parseInt(commandArgs(ctx), 10);
    const limit =
      Number.isInteger(requested) && requested > 0
        ? Math.min(requested, 50)
        : UPCOMING_LIMIT;

    const today = todayIso(config.timezone);
    const upcoming = loaded.bookings
      .filter((booking) => (booking.checkIn ?? "") >= today)
      .sort((a, b) => (a.checkIn ?? "").localeCompare(b.checkIn ?? ""));

    await ctx.reply(formatUpcoming(upcoming, config, limit) + loaded.warning, {
      parse_mode: "HTML",
    });
  });

  bot.command(["availability", "free"], async (ctx) => {
    const loaded = await bookingsFor(ctx);
    if (!loaded) return;

    const requested = Number.parseInt(commandArgs(ctx), 10);
    const days =
      Number.isInteger(requested) && requested > 0
        ? Math.min(requested, 180)
        : config.availabilityDays;

    const report = buildAvailability(loaded.bookings, {
      days,
      timezone: config.timezone,
    });

    await ctx.reply(formatAvailability(report, config) + loaded.warning, {
      parse_mode: "HTML",
    });
  });

  // Anything that isn't a command: treat a pasted link as an add. In groups
  // and channels this stays silent unless a link is actually present, so the
  // bot doesn't interject in ordinary conversation.
  bot.on(["message:text", "channel_post:text"], async (ctx) => {
    const text = (ctx.msg?.text ?? "").trim();
    if (text.startsWith("/")) return;

    const match = URL_IN_TEXT.exec(text);
    if (match) {
      await handleLink(ctx, match[0]);
      return;
    }

    const chatId = chatIdOf(ctx);
    if (awaitingLink.has(chatId) && ctx.chat?.type === "private") {
      await ctx.reply(
        "That doesn't look like a link. I need the iCal export URL from NoBeds (Channels → iCal Export) - it starts with <code>https://</code>.",
        { parse_mode: "HTML" },
      );
    }
  });

  bot.catch((error) => {
    console.error("[bot] update handler error:", error.message);
  });

  return bot;
}

/** Shown in Telegram's command menu. */
export const BOT_COMMANDS = [
  { command: "start", description: "Add your NoBeds iCal link" },
  { command: "availability", description: "What's free, and when" },
  { command: "upcoming", description: "Next arrivals" },
  { command: "list", description: "Links this chat watches" },
  { command: "add", description: "Watch another iCal link" },
  { command: "remove", description: "Stop watching a link" },
  { command: "poll", description: "Check the feeds right now" },
  { command: "status", description: "Feed health and link expiry" },
  { command: "help", description: "Show the commands" },
];
