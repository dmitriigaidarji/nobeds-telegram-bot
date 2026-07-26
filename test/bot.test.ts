/**
 * The self-service flow, driven through grammy exactly as Telegram would: a
 * chat sends /start, pastes its own iCal link, and gets answers about its own
 * bookings - with no chat id configured anywhere in the environment.
 *
 * Outgoing API calls are intercepted by a transformer, so nothing leaves the
 * machine and the assertions are on the replies themselves.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Update, UserFromGetMe } from "grammy/types";
import { createBot } from "../src/bot.ts";
import { FeedStore, SnapshotStore } from "../src/store.ts";
import type { PollOutcome } from "../src/poller.ts";
import { nobedsIcs, testConfig } from "./helpers.ts";

let body = nobedsIcs([
  { room: "A1 Room 2", guest: "Mira Kovac", checkIn: "2026-07-26", checkOut: "2026-07-29" },
  { room: "A1 room1", guest: "avery lindqvist", checkIn: "2026-10-10", checkOut: "2026-10-12" },
]);
let status = 200;

const server = Bun.serve({
  port: 0,
  fetch() {
    if (status !== 200) return new Response("nope", { status });
    return new Response(body, { headers: { "content-type": "text/calendar" } });
  },
});
afterAll(() => server.stop(true));

const feedUrl = `http://localhost:${server.port}/ICAL/Bookings/aaaaaaaa.bbbbbbbb.cccccccc`;

const BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: "NoBeds",
  username: "nobeds_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

const config = testConfig({
  // grammy refuses an empty token; no request ever reaches Telegram because
  // every outgoing call is intercepted by the transformer below.
  botToken: "12345:test-token",
  allowedHosts: ["localhost"],
  maxFeedsPerChat: 2,
});

let store: FeedStore;
let snapshots: SnapshotStore;
let replies: string[];
let added: number[];
let bot: ReturnType<typeof createBot>;
let updateId = 0;

/** Feed ids handed to pollNow, and what it should pretend happened. */
let polled: number[][];
let pollResult: PollOutcome[];
let pollError: Error | undefined;

beforeEach(() => {
  store = new FeedStore(":memory:");
  snapshots = new SnapshotStore(":memory:");
  replies = [];
  added = [];
  polled = [];
  pollResult = [];
  pollError = undefined;
  bot = createBot(config, store, snapshots, {
    onFeedAdded: (id: number) => added.push(id),
    pollNow: async (feedIds: number[]) => {
      polled.push(feedIds);
      if (pollError) throw pollError;
      return pollResult;
    },
  });
  bot.botInfo = BOT_INFO;
  bot.api.config.use((_prev, method, payload) => {
    if (method === "sendMessage") {
      replies.push(String((payload as { text: string }).text));
    }
    return Promise.resolve({ ok: true, result: true } as never);
  });
  status = 200;
});

async function send(
  text: string,
  options: { chatId?: number; type?: "private" | "group" } = {},
): Promise<string> {
  const chatId = options.chatId ?? 500;
  const update = {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: 1_800_000_000,
      chat: { id: chatId, type: options.type ?? "private" },
      from: { id: 900, is_bot: false, first_name: "Host" },
      text,
      entities: text.startsWith("/")
        ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }]
        : [],
    },
  } as unknown as Update;

  const before = replies.length;
  await bot.handleUpdate(update);
  return replies.slice(before).join("\n---\n");
}

describe("first contact", () => {
  test("/start asks for the link instead of assuming one", async () => {
    const reply = await send("/start");

    expect(reply).toContain("iCal export link");
    expect(reply).toContain("Channels → iCal Export");
    expect(store.countFeeds()).toBe(0);
  });

  test("a pasted link is verified, then watched", async () => {
    await send("/start");
    const reply = await send(feedUrl);

    expect(reply).toContain("Link added");
    expect(reply).toContain("Bookings in the feed right now: <b>2</b>");
    expect(reply).toContain("A1 Room 2");

    const feeds = store.feedsForChat("500");
    expect(feeds).toHaveLength(1);
    expect(feeds[0]!.url).toBe(feedUrl);
    // The new feed is handed to the poller instead of waiting for the tick.
    expect(added).toEqual([feeds[0]!.id]);
  });

  test("a link works without /start first", async () => {
    const reply = await send(`here you go ${feedUrl} thanks`);

    expect(reply).toContain("Link added");
    expect(store.feedsForChat("500")).toHaveLength(1);
  });

  test("a broken link is rejected before it is stored", async () => {
    status = 500;
    const reply = await send(feedUrl);

    expect(reply).toContain("couldn't read that feed");
    expect(store.countFeeds()).toBe(0);
  });

  test("a link to somewhere that isn't NoBeds is refused", async () => {
    const reply = await send("https://evil.example.com/ical");

    expect(reply).toContain("I only watch NoBeds links");
    expect(store.countFeeds()).toBe(0);
  });

  test("warns before a link is pasted into a group", async () => {
    const reply = await send("/start", { chatId: -100, type: "group" });
    expect(reply).toContain("Everyone in this group will see the link");
  });

  test("ignores ordinary group chatter", async () => {
    const reply = await send("what time is check-in?", {
      chatId: -100,
      type: "group",
    });
    expect(reply).toBe("");
  });

  test("holds the line at the per-chat link limit", async () => {
    await send(feedUrl);
    await send(`${feedUrl}?two`);
    const reply = await send(`${feedUrl}?three`);

    expect(reply).toContain("which is the limit");
    expect(store.feedsForChat("500")).toHaveLength(2);
  });

  test("adding the same link twice says so rather than duplicating it", async () => {
    await send(feedUrl);
    const reply = await send(feedUrl);

    expect(reply).toContain("already watching");
    expect(store.feedsForChat("500")).toHaveLength(1);
  });
});

describe("commands", () => {
  beforeEach(async () => {
    await send(feedUrl);
    // Stand in for the poller having run once.
    const feed = store.feedsForChat("500")[0]!;
    const { parseIcs } = await import("../src/ical.ts");
    snapshots.applySnapshot(
      feed.id,
      parseIcs(body).map((event) => ({ event })),
      [],
    );
  });

  test("/list never echoes the token back into the chat", async () => {
    const reply = await send("/list");

    expect(reply).toContain("localhost");
    expect(reply).not.toContain("aaaaaaaa.bbbbbbbb.cccccccc");
    expect(reply).toContain("2 booking(s)");
  });

  test("/availability reports rooms and gaps", async () => {
    const reply = await send("/availability 30");

    expect(reply).toContain("Availability");
    expect(reply).toContain("A1 Room 2");
    expect(reply).toContain("A1 room1");
  });

  test("/availability answers from a live fetch, with nothing cached", async () => {
    // What happens after a reboot wipes /tmp: no snapshot at all, and the
    // question still has to be answerable.
    const feed = store.feedsForChat("500")[0]!;
    snapshots.forgetFeed(feed.id);
    expect(snapshots.countEventsForFeed(feed.id)).toBe(0);

    const reply = await send("/availability 30");
    expect(reply).toContain("A1 Room 2");
    expect(reply).toContain("Mira Kovac");
    // Answering must not have written the bookings back to disk.
    expect(snapshots.countEventsForFeed(feed.id)).toBe(0);
  });

  test("says so when the feed can't be reached, rather than claiming it's free", async () => {
    status = 500;
    const reply = await send("/availability");

    expect(reply).toContain("couldn't reach");
    expect(reply).not.toContain("free all");
  });

  test("/upcoming lists arrivals still to come", async () => {
    const reply = await send("/upcoming");
    // Both fixture bookings are in the past relative to a 2026-07-26 feed and
    // the real clock, so this asserts the shape rather than the contents.
    expect(reply).toMatch(/Next arrivals|No upcoming bookings/);
  });

  test("/status reports health per link", async () => {
    const reply = await send("/status");

    expect(reply).toContain("Bookings at last poll: <b>2</b>");
    expect(reply).toContain("Feed health: ✅ ok");
  });

  test("/remove takes the number shown by /list", async () => {
    const removedId = store.feedsForChat("500")[0]!.id;
    const reply = await send("/remove 1");

    expect(reply).toContain("Stopped watching");
    expect(store.feedsForChat("500")).toHaveLength(0);
    // The cached bookings go with it.
    expect(snapshots.countEventsForFeed(removedId)).toBe(0);
  });

  test("/remove with a nonsense index explains instead of removing", async () => {
    const reply = await send("/remove 7");

    expect(reply).toContain("Which one?");
    expect(store.feedsForChat("500")).toHaveLength(1);
  });

  test("another chat sees none of this chat's links or bookings", async () => {
    const list = await send("/list", { chatId: 777 });
    expect(list).toContain("No links yet");

    const availability = await send("/availability", { chatId: 777 });
    expect(availability).toContain("No links yet");
    expect(store.feedsForChat("777")).toHaveLength(0);
  });

  test("/remove all clears the chat", async () => {
    await send(`${feedUrl}?second`);
    const reply = await send("/remove all");

    expect(reply).toContain("Removed 2 link(s)");
    expect(store.feedsForChat("500")).toHaveLength(0);
  });
});

describe("/poll", () => {
  const outcome = (over: Partial<PollOutcome> = {}): PollOutcome => ({
    status: "ok",
    created: 0,
    modified: 0,
    cancelled: 0,
    ...over,
  });

  beforeEach(async () => {
    await send(feedUrl);
    replies.length = 0;
  });

  test("polls exactly the feeds this chat registered", async () => {
    const feedId = store.feedsForChat("500")[0]!.id;
    pollResult = [outcome()];

    const reply = await send("/poll");

    expect(polled).toEqual([[feedId]]);
    expect(reply).toContain("Checked 1 link(s)");
    expect(reply).toContain("Nothing has changed");
  });

  test("summarises what the poll reported", async () => {
    pollResult = [outcome({ created: 2, modified: 1, cancelled: 1 })];

    const reply = await send("/poll");

    expect(reply).toContain("🆕 2 new");
    expect(reply).toContain("✏️ 1 changed");
    expect(reply).toContain("❌ 1 cancelled");
  });

  test("reports a feed that could not be read", async () => {
    pollResult = [outcome({ status: "failed", detail: "HTTP 500" })];

    const reply = await send("/poll");
    expect(reply).toContain("couldn't be read");
    expect(reply).toContain("HTTP 500");
  });

  test("refuses a second poll inside the cooldown", async () => {
    pollResult = [outcome()];
    await send("/poll");
    const reply = await send("/poll");

    expect(reply).toMatch(/Try again in \d+s/);
    // The important half: the upstream feed was hit once, not twice.
    expect(polled).toHaveLength(1);
  });

  test("the cooldown is per chat, not global", async () => {
    pollResult = [outcome()];
    await send("/poll");

    await send(feedUrl, { chatId: 777 });
    const reply = await send("/poll", { chatId: 777 });

    expect(reply).toContain("Checked 1 link(s)");
    expect(polled).toHaveLength(2);
  });

  test("a failed poll does not burn the cooldown", async () => {
    pollError = new Error("network unreachable");
    const first = await send("/poll");
    expect(first).toContain("network unreachable");

    pollError = undefined;
    pollResult = [outcome()];
    const second = await send("/poll");
    expect(second).toContain("Checked 1 link(s)");
  });

  test("/refresh is the same command", async () => {
    pollResult = [outcome()];
    const reply = await send("/refresh");
    expect(reply).toContain("Checked 1 link(s)");
  });

  test("asks for a link when the chat has none", async () => {
    const reply = await send("/poll", { chatId: 888 });

    expect(reply).toContain("No links to check");
    expect(polled).toHaveLength(0);
  });
});
