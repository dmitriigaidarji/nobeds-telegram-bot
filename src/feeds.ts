/**
 * Registering an iCal link, shared by the Telegram command handlers and the
 * optional env-var bootstrap.
 *
 * A link is probed before it is stored: fetched once and parsed. Storing an
 * unverified URL would mean the user pastes a typo, sees "ok", and then hears
 * nothing forever - the exact failure this bot is supposed to prevent.
 */

import { checkIcalUrl } from "./config.ts";
import type { Config } from "./config.ts";
import { fetchIcal } from "./fetcher.ts";
import { parseIcs } from "./ical.ts";
import { detailsFromEvent } from "./booking.ts";
import type { BookingDetails } from "./booking.ts";
import type { Feed, FeedStore } from "./store.ts";

export type RegisterResult =
  | {
      ok: true;
      feed: Feed;
      alreadyWatching: boolean;
      bookings: number;
      rooms: string[];
    }
  | { ok: false; reason: string };

export async function registerFeed(
  store: FeedStore,
  config: Config,
  chatId: string,
  rawUrl: string,
  options: { probe?: boolean } = {},
): Promise<RegisterResult> {
  const check = checkIcalUrl(rawUrl, config.allowedHosts);
  if (!check.ok || !check.url) {
    return { ok: false, reason: check.reason ?? "That link doesn't look right." };
  }
  const url = check.url;

  const existing = store.findFeed(chatId, url);
  if (!existing && store.feedsForChat(chatId).length >= config.maxFeedsPerChat) {
    return {
      ok: false,
      reason: `This chat is already watching ${config.maxFeedsPerChat} links, which is the limit. Drop one with /remove first.`,
    };
  }

  let bookings = 0;
  const rooms = new Set<string>();

  if (options.probe !== false) {
    try {
      const result = await fetchIcal(url, {});
      const events = parseIcs(result.body ?? "");
      bookings = events.length;
      for (const event of events) {
        const room = detailsFromEvent(event).room;
        if (room) rooms.add(room);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason: `I couldn't read that feed:\n\n<code>${reason.replace(/[<>&]/g, "")}</code>\n\nCheck the link in NoBeds under Channels → iCal Export and send it again.`,
      };
    }
  }

  const feed = store.addFeed(chatId, url);
  return {
    ok: true,
    feed,
    alreadyWatching: existing !== undefined && !existing.disabled,
    bookings,
    rooms: [...rooms].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  };
}

export interface LoadedBookings {
  bookings: BookingDetails[];
  failed: Array<{ feed: Feed; reason: string }>;
}

/**
 * Fetch every feed and return the bookings, without touching any store.
 *
 * `/availability` and `/upcoming` answer from this rather than from the
 * snapshot: it is always current, it works before the first poll or after the
 * snapshot has been wiped, and no guest data has to be on disk for a question
 * about availability to be answerable.
 */
export async function loadBookings(feeds: Feed[]): Promise<LoadedBookings> {
  type Outcome =
    | { ok: true; feed: Feed; details: BookingDetails[] }
    | { ok: false; feed: Feed; reason: string };

  const results = await Promise.all(
    feeds.map(async (feed): Promise<Outcome> => {
      try {
        const result = await fetchIcal(feed.url, {});
        return {
          ok: true,
          feed,
          details: parseIcs(result.body ?? "").map(detailsFromEvent),
        };
      } catch (error) {
        return {
          ok: false,
          feed,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const bookings: BookingDetails[] = [];
  const failed: LoadedBookings["failed"] = [];
  for (const result of results) {
    if (result.ok) bookings.push(...result.details);
    else failed.push({ feed: result.feed, reason: result.reason });
  }
  return { bookings, failed };
}
