/**
 * Two stores with two different jobs:
 *
 * - FeedStore is persistent and holds only the registered links. The test that
 *   matters most here is the one asserting no guest data can reach it.
 * - SnapshotStore is disposable last-poll data, used purely to diff.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeedStore, SnapshotStore } from "../src/store.ts";
import { parseIcs } from "../src/ical.ts";
import { checkIcalUrl } from "../src/config.ts";
import { nobedsIcs } from "./helpers.ts";

const URL_A = "https://nobeds.app/ICAL/Bookings/aaa.bbb.ccc";
const URL_B = "https://nobeds.app/ICAL/Bookings/ddd.eee.fff";

function tempPath(tag: string): string {
  return join(
    tmpdir(),
    `nobeds-${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
}

function removeQuietly(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(path + suffix);
    } catch {
      // already gone
    }
  }
}

function snapshotOf(store: SnapshotStore, feedId: number, ics: string): void {
  store.applySnapshot(
    feedId,
    parseIcs(ics).map((event) => ({ event })),
    [],
  );
}

const GUEST_ICS = nobedsIcs([
  {
    room: "A1",
    guest: "Mira Kovac",
    checkIn: "2026-08-01",
    checkOut: "2026-08-03",
    address: "19 Cecil St",
  },
]);

describe("FeedStore", () => {
  test("registers a link per chat", () => {
    const store = new FeedStore(":memory:");
    const feed = store.addFeed("1", URL_A);

    expect(feed.chatId).toBe("1");
    expect(feed.url).toBe(URL_A);
    expect(store.feedsForChat("1")).toHaveLength(1);
    expect(store.feedsForChat("2")).toHaveLength(0);
  });

  test("adding the same link twice is idempotent", () => {
    const store = new FeedStore(":memory:");
    const first = store.addFeed("1", URL_A);
    const second = store.addFeed("1", URL_A);

    expect(second.id).toBe(first.id);
    expect(store.feedsForChat("1")).toHaveLength(1);
  });

  test("two chats can watch the same link independently", () => {
    const store = new FeedStore(":memory:");
    const a = store.addFeed("1", URL_A);
    const b = store.addFeed("2", URL_A);

    expect(a.id).not.toBe(b.id);
    expect(store.activeFeeds()).toHaveLength(2);
  });

  test("removing takes the link out of the rotation", () => {
    const store = new FeedStore(":memory:");
    const feed = store.addFeed("1", URL_A);

    store.removeFeed(feed.id);
    expect(store.feedsForChat("1")).toHaveLength(0);
    expect(store.activeFeeds()).toHaveLength(0);
  });

  test("removeFeedsForChat reports what it removed, so the caller can clean up", () => {
    const store = new FeedStore(":memory:");
    store.addFeed("1", URL_A);
    store.addFeed("1", URL_B);
    store.addFeed("2", URL_A);

    const removed = store.removeFeedsForChat("1");
    expect(removed).toHaveLength(2);
    expect(store.feedsForChat("2")).toHaveLength(1);
  });

  test("a blocked chat is disabled, and re-adding switches it back on", () => {
    const store = new FeedStore(":memory:");
    const feed = store.addFeed("1", URL_A);
    store.disableChat("1", "blocked");

    expect(store.activeFeeds()).toHaveLength(0);
    expect(store.getFeed(feed.id)!.disabledReason).toBe("blocked");

    const again = store.addFeed("1", URL_A);
    expect(again.id).toBe(feed.id);
    expect(again.disabled).toBe(false);
    expect(store.activeFeeds()).toHaveLength(1);
  });

  test("the persistent database holds links only - no guest data at all", () => {
    // The whole point of the split. If a booking column ever appears here,
    // guest names have started landing on the persistent volume.
    const path = tempPath("feeds");
    const store = new FeedStore(path);
    const feed = store.addFeed("1", URL_A);

    const snapshots = new SnapshotStore(":memory:");
    snapshotOf(snapshots, feed.id, GUEST_ICS);
    store.close();
    snapshots.close();

    const raw = new Database(path);
    const tables = raw
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(["feeds"]);

    const columns = raw
      .query<{ name: string }, []>("PRAGMA table_info(feeds)")
      .all()
      .map((row) => row.name);
    for (const forbidden of ["summary", "description", "location", "room"]) {
      expect(columns).not.toContain(forbidden);
    }

    // And the guest's name appears nowhere in the file's bytes.
    const dump = raw
      .query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master")
      .all()
      .map((row) => row.sql ?? "")
      .join(" ");
    expect(dump).not.toContain("Mira Kovac");
    raw.close();
    removeQuietly(path);
  });
});

describe("SnapshotStore", () => {
  test("an unpolled feed has empty state rather than no state", () => {
    const snapshots = new SnapshotStore(":memory:");
    const state = snapshots.state(99);

    expect(state.seededAt).toBeNull();
    expect(state.failureCount).toBe(0);
  });

  test("patchState only writes the columns it was given", () => {
    const snapshots = new SnapshotStore(":memory:");

    snapshots.patchState(1, { failureCount: 3, lastError: "boom" });
    snapshots.patchState(1, { failureCount: 0 });

    const state = snapshots.state(1);
    expect(state.failureCount).toBe(0);
    expect(state.lastError).toBe("boom");
  });

  test("a snapshot replaces rows by booking key, not by UID", () => {
    const snapshots = new SnapshotStore(":memory:");
    const spec = {
      room: "A1",
      guest: "Guest",
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
    };

    snapshotOf(snapshots, 1, nobedsIcs([spec]));
    snapshotOf(snapshots, 1, nobedsIcs([spec])); // fresh UIDs, same booking

    expect(snapshots.countEventsForFeed(1)).toBe(1);
    const row = [...snapshots.eventsForFeed(1).values()][0]!;
    expect(row.room).toBe("A1");
    expect(row.checkIn).toBe("2026-08-01");
    expect(row.nights).toBe(2);
  });

  test("feeds don't see each other's bookings", () => {
    const snapshots = new SnapshotStore(":memory:");
    snapshotOf(snapshots, 1, GUEST_ICS);
    snapshotOf(
      snapshots,
      2,
      nobedsIcs([
        { room: "B1", guest: "Someone", checkIn: "2026-08-01", checkOut: "2026-08-02" },
      ]),
    );

    expect([...snapshots.eventsForFeed(1).values()].map((e) => e.summary)).toEqual(
      ["Mira Kovac"],
    );
    expect(snapshots.countEventsForFeed(2)).toBe(1);
  });

  test("forgetFeed drops the bookings and the polling state together", () => {
    const snapshots = new SnapshotStore(":memory:");
    snapshotOf(snapshots, 1, GUEST_ICS);
    snapshots.patchState(1, { seededAt: "2026-07-26T00:00:00Z" });

    snapshots.forgetFeed(1);

    expect(snapshots.countEventsForFeed(1)).toBe(0);
    // Seeded state must go too, or a re-added link would skip its silent seed
    // and announce every existing booking as new.
    expect(snapshots.state(1).seededAt).toBeNull();
  });

  test("losing the snapshot entirely just means the next poll re-seeds", () => {
    const path = tempPath("snap");
    const first = new SnapshotStore(path);
    snapshotOf(first, 1, GUEST_ICS);
    first.patchState(1, { seededAt: "2026-07-26T00:00:00Z" });
    first.close();

    // What a reboot does to /tmp.
    removeQuietly(path);

    const second = new SnapshotStore(path);
    expect(second.countEventsForFeed(1)).toBe(0);
    expect(second.state(1).seededAt).toBeNull();
    second.close();
    removeQuietly(path);
  });
});

describe("migration", () => {
  test("a v2 database keeps its links and drops the booking tables", () => {
    const path = tempPath("v2");
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE feeds (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL,
        url TEXT NOT NULL, label TEXT, added_at TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        UNIQUE(chat_id, url)
      );
      CREATE TABLE events (
        feed_id INTEGER NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL,
        summary TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
        PRIMARY KEY (feed_id, key)
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO feeds (chat_id, url, added_at) VALUES ('77', '${URL_A}', 'x');
      INSERT INTO events VALUES (1, 'k', 'h', 'Mira Kovac', 'x', 'x');
      PRAGMA user_version = 2;
    `);
    legacy.close();

    const store = new FeedStore(path);
    const feeds = store.feedsForChat("77");
    expect(feeds).toHaveLength(1);
    expect(feeds[0]!.url).toBe(URL_A);

    // v2's feeds table had no disabled_reason, so this is the call that used
    // to blow up at runtime the first time a chat blocked the bot.
    store.disableChat("77", "blocked");
    expect(store.getFeed(feeds[0]!.id)!.disabledReason).toBe("blocked");
    expect(store.activeFeeds()).toHaveLength(0);
    store.close();

    const raw = new Database(path);
    const tables = raw
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(["feeds"]);

    // And the polling-state columns v2 kept in here are gone.
    const columns = raw
      .query<{ name: string }, []>("PRAGMA table_info(feeds)")
      .all()
      .map((row) => row.name);
    expect(columns.sort()).toEqual(
      [
        "added_at",
        "chat_id",
        "disabled",
        "disabled_reason",
        "id",
        "label",
        "url",
      ].sort(),
    );
    raw.close();
    removeQuietly(path);
  });

  test("a database already stamped v3 but with the v2 layout is still repaired", () => {
    // What an in-place upgrade produced before the reshape existed: the version
    // says current, the columns say otherwise.
    const path = tempPath("v3-stale");
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE feeds (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL,
        url TEXT NOT NULL, label TEXT, added_at TEXT NOT NULL,
        seeded_at TEXT, etag TEXT, failure_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, disabled INTEGER NOT NULL DEFAULT 0,
        UNIQUE(chat_id, url)
      );
      INSERT INTO feeds (chat_id, url, added_at) VALUES ('77', '${URL_A}', 'x');
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const store = new FeedStore(path);
    expect(store.feedsForChat("77")).toHaveLength(1);
    store.disableChat("77", "blocked");
    expect(store.feedsForChat("77")[0]!.disabledReason).toBe("blocked");
    store.close();
    removeQuietly(path);
  });

  test("a v1 database opens instead of crashing on startup", () => {
    const path = tempPath("v1");
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE events (
        uid TEXT PRIMARY KEY, hash TEXT NOT NULL, summary TEXT,
        first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO events VALUES ('old-uid','h','Mira Kovac','x','x');
    `);
    legacy.close();

    const store = new FeedStore(path);
    expect(store.countFeeds()).toBe(0);
    const feed = store.addFeed("1", URL_A);
    expect(feed.id).toBeGreaterThan(0);
    store.close();
    removeQuietly(path);
  });
});

describe("checkIcalUrl", () => {
  test("accepts a NoBeds link", () => {
    const result = checkIcalUrl(URL_A, ["nobeds.app", "nobeds.com"]);
    expect(result.ok).toBe(true);
    expect(result.url).toBe(URL_A);
  });

  test("accepts a subdomain of an allowed host", () => {
    expect(
      checkIcalUrl("https://ical.nobeds.com/x.y.z", ["nobeds.com"]).ok,
    ).toBe(true);
  });

  test("refuses to be pointed at somebody else's server", () => {
    const result = checkIcalUrl("https://evil.example.com/ical", ["nobeds.app"]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("evil.example.com");
  });

  test("refuses a lookalike host", () => {
    expect(checkIcalUrl("https://nobeds.app.evil.com/x", ["nobeds.app"]).ok).toBe(
      false,
    );
  });

  test("requires https away from loopback", () => {
    expect(checkIcalUrl("http://nobeds.app/x", ["nobeds.app"]).ok).toBe(false);
    expect(checkIcalUrl("file:///etc/passwd", ["nobeds.app"]).ok).toBe(false);
    // http on loopback is allowed, but only if loopback was allowlisted.
    expect(checkIcalUrl("http://localhost:8080/x", ["localhost"]).ok).toBe(true);
    expect(checkIcalUrl("http://localhost:8080/x", ["nobeds.app"]).ok).toBe(false);
  });

  test("rejects junk instead of throwing at the user", () => {
    expect(checkIcalUrl("hello", ["nobeds.app"]).ok).toBe(false);
    expect(checkIcalUrl("", ["nobeds.app"]).ok).toBe(false);
  });
});
