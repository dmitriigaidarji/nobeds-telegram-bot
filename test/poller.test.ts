/**
 * End-to-end coverage of the poll cycle against a local stand-in for the
 * NoBeds feed: fetch → parse → diff → notify → persist. Telegram is stubbed,
 * so this asserts on the messages that would have been sent, and to which chat.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Poller } from "../src/poller.ts";
import { FeedStore, SnapshotStore } from "../src/store.ts";
import type { Notifier } from "../src/notifier.ts";
import { nobedsIcs, testConfig } from "./helpers.ts";
import type { BookingSpec } from "./helpers.ts";

class FakeNotifier {
  sent: Array<{ chatId: string; text: string }> = [];
  async send(chatId: string, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }
  get messages(): string[] {
    return this.sent.map((entry) => entry.text);
  }
  clear(): void {
    this.sent = [];
  }
}

let body = "";
let etag: string | undefined;
let status = 200;

const server = Bun.serve({
  port: 0,
  fetch(request) {
    if (status !== 200) return new Response("nope", { status });
    if (etag && request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304 });
    }
    const headers: Record<string, string> = { "content-type": "text/calendar" };
    if (etag) headers.etag = etag;
    return new Response(body, { headers });
  },
});

afterAll(() => server.stop(true));

const CHAT = "4242";
const config = testConfig({ failureAlertThreshold: 2 });

let store: FeedStore;
let snapshots: SnapshotStore;
let notifier: FakeNotifier;
let poller: Poller;
let feedId: number;

beforeEach(() => {
  store = new FeedStore(":memory:");
  snapshots = new SnapshotStore(":memory:");
  notifier = new FakeNotifier();
  poller = new Poller(config, store, snapshots, notifier as unknown as Notifier);
  feedId = store.addFeed(CHAT, `http://localhost:${server.port}/ical`).id;
  etag = undefined;
  status = 200;
});

const BOOKING_A: BookingSpec = {
  room: "A1 Room 2",
  guest: "John Smith",
  checkIn: "2026-08-03",
  checkOut: "2026-08-07",
};
const BOOKING_B: BookingSpec = {
  room: "A1 Room 3",
  guest: "Ana Petrova",
  checkIn: "2026-09-01",
  checkOut: "2026-09-03",
};

describe("Poller", () => {
  test("seeds silently on first run instead of announcing every existing stay", async () => {
    body = nobedsIcs([BOOKING_A, BOOKING_B]);

    const outcome = await poller.runOnce(feedId);

    expect(outcome.status).toBe("seeded");
    expect(snapshots.countEventsForFeed(feedId)).toBe(2);
    // One "now watching" note, and crucially not one message per booking.
    expect(notifier.messages).toHaveLength(1);
    expect(notifier.messages[0]).toContain("Seeded with 2 existing booking");
    expect(notifier.sent[0]!.chatId).toBe(CHAT);
  });

  test("stays silent when the feed re-renders with new UIDs", async () => {
    // Every fetch of nobedsIcs mints fresh UIDs and DTSTAMPs, exactly like the
    // live export. Nothing about the bookings changed, so nobody gets a message.
    body = nobedsIcs([BOOKING_A, BOOKING_B]);
    await poller.runOnce(feedId);
    notifier.clear();

    body = nobedsIcs([BOOKING_A, BOOKING_B], { stamp: "20260726T220000Z" });
    const outcome = await poller.runOnce(feedId);

    expect(outcome).toMatchObject({ status: "ok", created: 0, cancelled: 0, modified: 0 });
    expect(notifier.messages).toHaveLength(0);
    expect(snapshots.countEventsForFeed(feedId)).toBe(2);
  });

  test("announces a booking that appears after seeding", async () => {
    body = nobedsIcs([BOOKING_A]);
    await poller.runOnce(feedId);
    notifier.clear();

    body = nobedsIcs([BOOKING_A, BOOKING_B]);
    const outcome = await poller.runOnce(feedId);

    expect(outcome).toMatchObject({ status: "ok", created: 1, cancelled: 0 });
    expect(notifier.messages).toHaveLength(1);
    const message = notifier.messages[0]!;
    expect(message).toContain("New booking");
    expect(message).toContain("Ana Petrova");
    expect(message).toContain("A1 Room 3");
    expect(message).toMatch(/1 Sep(t)? 2026/);
    expect(message).toContain("2 nights");
  });

  test("uses conditional requests when the server offers an ETag", async () => {
    body = nobedsIcs([BOOKING_A]);
    etag = '"v1"';
    await poller.runOnce(feedId);
    notifier.clear();

    const outcome = await poller.runOnce(feedId);

    expect(outcome.status).toBe("unchanged");
    expect(notifier.messages).toHaveLength(0);
  });

  test("reports a cancellation when a future booking disappears", async () => {
    body = nobedsIcs([BOOKING_A, BOOKING_B]);
    await poller.runOnce(feedId);
    notifier.clear();

    body = nobedsIcs([BOOKING_A]);
    const outcome = await poller.runOnce(feedId);

    expect(outcome).toMatchObject({ status: "ok", cancelled: 1 });
    expect(notifier.messages[0]).toContain("Booking cancelled");
    expect(notifier.messages[0]).toContain("Ana Petrova");
    expect(snapshots.countEventsForFeed(feedId)).toBe(1);
  });

  test("refuses to read an empty feed as a mass cancellation", async () => {
    body = nobedsIcs([BOOKING_A, BOOKING_B]);
    await poller.runOnce(feedId);
    notifier.clear();

    body = nobedsIcs([]);
    const outcome = await poller.runOnce(feedId);

    expect(outcome.status).toBe("suspicious");
    // Snapshot preserved - no cancellations invented.
    expect(snapshots.countEventsForFeed(feedId)).toBe(2);
    expect(notifier.messages).toHaveLength(1);
    expect(notifier.messages[0]).toContain("zero bookings");
  });

  test("alerts once the failure threshold is crossed, then on recovery", async () => {
    body = nobedsIcs([BOOKING_A]);
    await poller.runOnce(feedId);
    notifier.clear();

    status = 500;
    expect((await poller.runOnce(feedId)).status).toBe("failed");
    expect(notifier.messages).toHaveLength(0); // below threshold of 2

    expect((await poller.runOnce(feedId)).status).toBe("failed");
    expect(notifier.messages).toHaveLength(1);
    expect(notifier.messages[0]).toContain("Cannot reach the NoBeds feed");

    notifier.clear();
    status = 200;
    expect((await poller.runOnce(feedId)).status).toBe("ok");
    expect(notifier.messages).toHaveLength(1);
    expect(notifier.messages[0]).toContain("Feed recovered");
  });

  test("does not lose a booking when a notification fails to send", async () => {
    body = nobedsIcs([BOOKING_A]);
    await poller.runOnce(feedId);

    const exploding = {
      send: async () => {
        throw new Error("telegram down");
      },
    } as unknown as Notifier;
    const failing = new Poller(config, store, snapshots, exploding);

    body = nobedsIcs([BOOKING_A, BOOKING_B]);
    await expect(failing.runOnce(feedId)).rejects.toThrow("telegram down");
    // Snapshot must not advance, so the next poll retries the same booking.
    expect(snapshots.countEventsForFeed(feedId)).toBe(1);

    body = nobedsIcs([BOOKING_A, BOOKING_B]);
    const retry = await poller.runOnce(feedId);
    expect(retry).toMatchObject({ created: 1 });
    expect(notifier.messages.at(-1)).toContain("Ana Petrova");
  });

  test("keeps two chats' feeds apart", async () => {
    const otherFeedId = store.addFeed(
      "9999",
      `http://localhost:${server.port}/ical?other=1`,
    ).id;

    body = nobedsIcs([BOOKING_A]);
    await poller.runOnce(feedId);
    await poller.runOnce(otherFeedId);
    notifier.clear();

    // A booking added to the shared stand-in feed reaches both chats, each
    // with its own snapshot - and never the wrong chat id.
    body = nobedsIcs([BOOKING_A, BOOKING_B]);
    await poller.runOnce(feedId);
    expect(notifier.sent.map((entry) => entry.chatId)).toEqual([CHAT]);

    await poller.runOnce(otherFeedId);
    expect(notifier.sent.map((entry) => entry.chatId)).toEqual([CHAT, "9999"]);
    expect(snapshots.countEventsForFeed(otherFeedId)).toBe(2);
    expect(snapshots.countEventsForFeed(feedId)).toBe(2);
  });

  test("re-seeds silently after the snapshot is wiped", async () => {
    // /tmp is cleared by a reboot. The next poll must adopt the feed quietly:
    // announcing every existing booking as new would be worse than the missed
    // notifications the wipe already cost.
    body = nobedsIcs([BOOKING_A, BOOKING_B]);
    await poller.runOnce(feedId);
    notifier.clear();

    snapshots.forgetFeed(feedId);

    const outcome = await poller.runOnce(feedId);

    expect(outcome.status).toBe("seeded");
    expect(notifier.messages).toHaveLength(1);
    expect(notifier.messages[0]).toContain("Seeded with 2 existing booking");
    expect(notifier.messages.join()).not.toContain("New booking");
    expect(snapshots.countEventsForFeed(feedId)).toBe(2);
  });

  test("skips a feed that was removed between the tick and the poll", async () => {
    store.removeFeed(feedId);
    expect((await poller.runOnce(feedId)).status).toBe("skipped");
  });
});
