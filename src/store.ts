/**
 * Two stores, on purpose.
 *
 * `FeedStore` is the only thing that has to survive a reboot, and it holds the
 * only thing worth keeping: which chat asked to watch which iCal link. It
 * contains no guest data at all.
 *
 * `SnapshotStore` holds last-poll booking data. That exists for exactly one
 * reason - iCal is a *state* feed, so "created / changed / cancelled" can only
 * be derived by comparing this poll against the previous one. It lives under
 * /tmp and is explicitly disposable: lose it and every feed silently re-seeds
 * on the next poll, which costs notifications for anything that changed while
 * the process was down, and nothing else. Guest names and addresses therefore
 * never reach the persistent volume.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { VEvent } from "./ical.ts";
import type { BookingDetails } from "./booking.ts";
import { bookingKey, detailsFromEvent } from "./booking.ts";

/** A NoBeds iCal export a chat asked us to watch. Persistent. */
export interface Feed {
  id: number;
  chatId: string;
  url: string;
  label: string | null;
  addedAt: string;
  disabled: boolean;
  disabledReason: string | null;
}

/** Per-feed polling state. Ephemeral: it describes the snapshot, not the feed. */
export interface FeedState {
  feedId: number;
  seededAt: string | null;
  etag: string | null;
  lastModified: string | null;
  failureCount: number;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastChangeAt: string | null;
  lastError: string | null;
  emptyAlertedAt: string | null;
  tokenWarnedBucket: string | null;
}

export interface StoredEvent {
  feedId: number;
  /** Content-derived identity - see bookingKey. NoBeds' UIDs are random. */
  key: string;
  uid: string | null;
  hash: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  status: string | null;
  dtstart: string | null;
  dtend: string | null;
  dateOnly: boolean;
  room: string | null;
  checkIn: string | null;
  checkOut: string | null;
  nights: number | null;
  firstSeen: string;
  lastSeen: string;
}

interface FeedRow {
  id: number;
  chat_id: string;
  url: string;
  label: string | null;
  added_at: string;
  disabled: number;
  disabled_reason: string | null;
}

interface StateRow {
  feed_id: number;
  seeded_at: string | null;
  etag: string | null;
  last_modified: string | null;
  failure_count: number;
  last_poll_at: string | null;
  last_success_at: string | null;
  last_change_at: string | null;
  last_error: string | null;
  empty_alerted_at: string | null;
  token_warned_bucket: string | null;
}

interface EventRow {
  feed_id: number;
  key: string;
  uid: string | null;
  hash: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  status: string | null;
  dtstart: string | null;
  dtend: string | null;
  date_only: number;
  room: string | null;
  checkin: string | null;
  checkout: string | null;
  nights: number | null;
  first_seen: string;
  last_seen: string;
}

/**
 * Fingerprint of the fields a human would care about.
 *
 * Deliberately excludes UID, DTSTAMP, CREATED and SEQUENCE. NoBeds regenerates
 * all of those on every single request - including a brand new random UID per
 * booking - so hashing them would mark every booking as modified on every poll.
 */
export function hashEvent(event: VEvent): string {
  const material = JSON.stringify([
    event.summary ?? "",
    event.description ?? "",
    event.location ?? "",
    event.status ?? "",
    event.dtstart?.raw ?? "",
    event.dtend?.raw ?? "",
  ]);
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

/* ------------------------------------------------------------ FeedStore -- */

function feedFromRow(row: FeedRow): Feed {
  return {
    id: row.id,
    chatId: row.chat_id,
    url: row.url,
    label: row.label,
    addedAt: row.added_at,
    disabled: row.disabled === 1,
    disabledReason: row.disabled_reason,
  };
}

export const FEED_SCHEMA_VERSION = 3;

/** The persistent half: iCal links, and nothing else. */
export class FeedStore {
  private db: Database;

  constructor(path: string) {
    this.db = openDatabase(path);
    this.migrate();
  }

  /**
   * v1 and v2 kept booking data in this database. That data is now ephemeral
   * and lives elsewhere, so the tables are dropped rather than carried
   * forward - the registered links, which are all that matter, are preserved
   * whenever v2 already had them.
   */
  private migrate(): void {
    const version = Number(
      this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version ?? 0,
    );

    this.db.exec(FeedStore.CREATE_FEEDS);
    this.reshapeLegacyFeeds();
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS feeds_by_chat ON feeds (chat_id)",
    );

    if (version < FEED_SCHEMA_VERSION) {
      // Booking data used to live in here. It is ephemeral now, and the next
      // poll rebuilds it from the feed, so these are dropped rather than moved.
      this.db.exec("DROP TABLE IF EXISTS events");
      this.db.exec("DROP TABLE IF EXISTS meta");
      this.db.exec(`PRAGMA user_version = ${FEED_SCHEMA_VERSION}`);
    }
  }

  private static readonly CREATE_FEEDS = `
    CREATE TABLE IF NOT EXISTS feeds (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id         TEXT NOT NULL,
      url             TEXT NOT NULL,
      label           TEXT,
      added_at        TEXT NOT NULL,
      disabled        INTEGER NOT NULL DEFAULT 0,
      disabled_reason TEXT,
      UNIQUE(chat_id, url)
    );
  `;

  private static readonly FEED_COLUMNS = [
    "id",
    "chat_id",
    "url",
    "label",
    "added_at",
    "disabled",
    "disabled_reason",
  ];

  /**
   * Bring a pre-existing `feeds` table to the current shape.
   *
   * v2 stored per-feed polling state in this table, so an upgraded database has
   * a `feeds` with the wrong columns - no `disabled_reason`, plus a dozen
   * leftovers. `CREATE TABLE IF NOT EXISTS` won't touch it, and the omission
   * only surfaces later as a runtime error the first time a chat blocks the
   * bot. Rebuild rather than patch, so every deployment converges on one shape.
   *
   * Keyed on the actual columns, not on user_version: a database already
   * stamped with the current version can still have the old layout.
   */
  private reshapeLegacyFeeds(): void {
    const columns = this.db
      .query<{ name: string }, []>("PRAGMA table_info(feeds)")
      .all()
      .map((row) => row.name);
    if (columns.length === 0) return;

    const canonical = FeedStore.FEED_COLUMNS;
    const matches =
      columns.length === canonical.length &&
      canonical.every((name) => columns.includes(name));
    if (matches) return;

    // Carry over only what both shapes have; anything else was polling state.
    const carried = canonical.filter((name) => columns.includes(name));

    this.db.transaction(() => {
      this.db.exec("DROP INDEX IF EXISTS feeds_by_chat");
      this.db.exec("ALTER TABLE feeds RENAME TO feeds_legacy");
      this.db.exec(FeedStore.CREATE_FEEDS);
      this.db.exec(
        `INSERT INTO feeds (${carried.join(", ")})
         SELECT ${carried.join(", ")} FROM feeds_legacy`,
      );
      this.db.exec("DROP TABLE feeds_legacy");
    })();
    console.log("[store] rebuilt the feeds table to the current schema");
  }

  /** Insert, or return the feed already watching this URL for this chat. */
  addFeed(chatId: string, url: string, label?: string): Feed {
    const existing = this.findFeed(chatId, url);
    if (existing) {
      if (existing.disabled) {
        this.db
          .prepare(
            "UPDATE feeds SET disabled = 0, disabled_reason = NULL WHERE id = ?",
          )
          .run(existing.id);
        return this.getFeed(existing.id) ?? existing;
      }
      return existing;
    }

    this.db
      .prepare(
        "INSERT INTO feeds (chat_id, url, label, added_at) VALUES (?, ?, ?, ?)",
      )
      .run(chatId, url, label ?? null, new Date().toISOString());

    const created = this.findFeed(chatId, url);
    if (!created) throw new Error("feed insert did not round-trip");
    return created;
  }

  findFeed(chatId: string, url: string): Feed | undefined {
    const row = this.db
      .query<FeedRow, [string, string]>(
        "SELECT * FROM feeds WHERE chat_id = ? AND url = ?",
      )
      .get(chatId, url);
    return row ? feedFromRow(row) : undefined;
  }

  getFeed(id: number): Feed | undefined {
    const row = this.db
      .query<FeedRow, [number]>("SELECT * FROM feeds WHERE id = ?")
      .get(id);
    return row ? feedFromRow(row) : undefined;
  }

  feedsForChat(chatId: string): Feed[] {
    return this.db
      .query<FeedRow, [string]>(
        "SELECT * FROM feeds WHERE chat_id = ? ORDER BY id",
      )
      .all(chatId)
      .map(feedFromRow);
  }

  activeFeeds(): Feed[] {
    return this.db
      .query<FeedRow, []>("SELECT * FROM feeds WHERE disabled = 0 ORDER BY id")
      .all()
      .map(feedFromRow);
  }

  countFeeds(): number {
    return (
      this.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM feeds")
        .get()?.n ?? 0
    );
  }

  removeFeed(id: number): void {
    this.db.prepare("DELETE FROM feeds WHERE id = ?").run(id);
  }

  removeFeedsForChat(chatId: string): Feed[] {
    const feeds = this.feedsForChat(chatId);
    this.db.prepare("DELETE FROM feeds WHERE chat_id = ?").run(chatId);
    return feeds;
  }

  /** Stop polling every feed of a chat - used when the bot gets blocked. */
  disableChat(chatId: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE feeds SET disabled = 1, disabled_reason = ? WHERE chat_id = ?",
      )
      .run(reason, chatId);
  }

  close(): void {
    this.db.close();
  }
}

/* -------------------------------------------------------- SnapshotStore -- */

function stateFromRow(row: StateRow): FeedState {
  return {
    feedId: row.feed_id,
    seededAt: row.seeded_at,
    etag: row.etag,
    lastModified: row.last_modified,
    failureCount: row.failure_count,
    lastPollAt: row.last_poll_at,
    lastSuccessAt: row.last_success_at,
    lastChangeAt: row.last_change_at,
    lastError: row.last_error,
    emptyAlertedAt: row.empty_alerted_at,
    tokenWarnedBucket: row.token_warned_bucket,
  };
}

function eventFromRow(row: EventRow): StoredEvent {
  return {
    feedId: row.feed_id,
    key: row.key,
    uid: row.uid,
    hash: row.hash,
    summary: row.summary,
    description: row.description,
    location: row.location,
    status: row.status,
    dtstart: row.dtstart,
    dtend: row.dtend,
    dateOnly: row.date_only === 1,
    room: row.room,
    checkIn: row.checkin,
    checkOut: row.checkout,
    nights: row.nights,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  };
}

function toEventRow(
  feedId: number,
  event: VEvent,
  details: BookingDetails,
  now: string,
): EventRow {
  return {
    feed_id: feedId,
    key: bookingKey(details),
    uid: event.uid || null,
    hash: hashEvent(event),
    summary: event.summary ?? null,
    description: event.description ?? null,
    location: event.location ?? null,
    status: event.status ?? null,
    dtstart: event.dtstart?.raw ?? null,
    dtend: event.dtend?.raw ?? null,
    date_only: event.dtstart?.dateOnly ? 1 : 0,
    room: details.room ?? null,
    checkin: details.checkIn ?? null,
    checkout: details.checkOut ?? null,
    nights: details.nights ?? null,
    first_seen: now,
    last_seen: now,
  };
}

const STATE_COLUMNS = {
  seededAt: "seeded_at",
  etag: "etag",
  lastModified: "last_modified",
  failureCount: "failure_count",
  lastPollAt: "last_poll_at",
  lastSuccessAt: "last_success_at",
  lastChangeAt: "last_change_at",
  lastError: "last_error",
  emptyAlertedAt: "empty_alerted_at",
  tokenWarnedBucket: "token_warned_bucket",
} as const;

export type StatePatch = Partial<{
  [K in keyof typeof STATE_COLUMNS]: string | number | boolean | null;
}>;

/**
 * The disposable half: last-poll bookings and the polling state that describes
 * them. Deleting this file is a supported operation - the next poll re-seeds.
 */
export class SnapshotStore {
  private db: Database;

  constructor(path: string) {
    this.db = openDatabase(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feed_state (
        feed_id             INTEGER PRIMARY KEY,
        seeded_at           TEXT,
        etag                TEXT,
        last_modified       TEXT,
        failure_count       INTEGER NOT NULL DEFAULT 0,
        last_poll_at        TEXT,
        last_success_at     TEXT,
        last_change_at      TEXT,
        last_error          TEXT,
        empty_alerted_at    TEXT,
        token_warned_bucket TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        feed_id     INTEGER NOT NULL,
        key         TEXT NOT NULL,
        uid         TEXT,
        hash        TEXT NOT NULL,
        summary     TEXT,
        description TEXT,
        location    TEXT,
        status      TEXT,
        dtstart     TEXT,
        dtend       TEXT,
        date_only   INTEGER NOT NULL DEFAULT 0,
        room        TEXT,
        checkin     TEXT,
        checkout    TEXT,
        nights      INTEGER,
        first_seen  TEXT NOT NULL,
        last_seen   TEXT NOT NULL,
        PRIMARY KEY (feed_id, key)
      );
    `);
  }

  /** Never null: an unknown feed is simply one that hasn't been polled yet. */
  state(feedId: number): FeedState {
    const row = this.db
      .query<StateRow, [number]>("SELECT * FROM feed_state WHERE feed_id = ?")
      .get(feedId);
    return row
      ? stateFromRow(row)
      : {
          feedId,
          seededAt: null,
          etag: null,
          lastModified: null,
          failureCount: 0,
          lastPollAt: null,
          lastSuccessAt: null,
          lastChangeAt: null,
          lastError: null,
          emptyAlertedAt: null,
          tokenWarnedBucket: null,
        };
  }

  patchState(feedId: number, patch: StatePatch): void {
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];

    for (const [field, value] of Object.entries(patch)) {
      const column = STATE_COLUMNS[field as keyof typeof STATE_COLUMNS];
      if (!column || value === undefined) continue;
      assignments.push(`${column} = ?`);
      values.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
    }
    if (assignments.length === 0) return;

    this.db
      .prepare("INSERT OR IGNORE INTO feed_state (feed_id) VALUES (?)")
      .run(feedId);
    values.push(feedId);
    this.db
      .prepare(
        `UPDATE feed_state SET ${assignments.join(", ")} WHERE feed_id = ?`,
      )
      .run(...values);
  }

  eventsForFeed(feedId: number): Map<string, StoredEvent> {
    const rows = this.db
      .query<EventRow, [number]>("SELECT * FROM events WHERE feed_id = ?")
      .all(feedId);
    return new Map(rows.map((row) => [row.key, eventFromRow(row)]));
  }

  countEventsForFeed(feedId: number): number {
    return (
      this.db
        .query<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM events WHERE feed_id = ?",
        )
        .get(feedId)?.n ?? 0
    );
  }

  /**
   * Replace a feed's snapshot, in one transaction so a crash mid-write can
   * never leave a half-applied snapshot that replays as spurious notifications.
   */
  applySnapshot(
    feedId: number,
    events: Array<{ event: VEvent; details?: BookingDetails }>,
    removedKeys: string[],
  ): void {
    const now = new Date().toISOString();
    const upsert = this.db.prepare(`
      INSERT INTO events (feed_id, key, uid, hash, summary, description,
                          location, status, dtstart, dtend, date_only,
                          room, checkin, checkout, nights,
                          first_seen, last_seen)
      VALUES ($feed_id, $key, $uid, $hash, $summary, $description,
              $location, $status, $dtstart, $dtend, $date_only,
              $room, $checkin, $checkout, $nights,
              $first_seen, $last_seen)
      ON CONFLICT(feed_id, key) DO UPDATE SET
        uid = excluded.uid,
        hash = excluded.hash,
        summary = excluded.summary,
        description = excluded.description,
        location = excluded.location,
        status = excluded.status,
        dtstart = excluded.dtstart,
        dtend = excluded.dtend,
        date_only = excluded.date_only,
        room = excluded.room,
        checkin = excluded.checkin,
        checkout = excluded.checkout,
        nights = excluded.nights,
        last_seen = excluded.last_seen
    `);
    const remove = this.db.prepare(
      "DELETE FROM events WHERE feed_id = ? AND key = ?",
    );

    this.db.transaction(() => {
      // Removals first: a booking whose dates moved is deleted under its old
      // key and re-inserted under the new one in the same transaction.
      for (const key of removedKeys) remove.run(feedId, key);

      for (const { event, details } of events) {
        const row = toEventRow(
          feedId,
          event,
          details ?? detailsFromEvent(event),
          now,
        );
        upsert.run({
          $feed_id: row.feed_id,
          $key: row.key,
          $uid: row.uid,
          $hash: row.hash,
          $summary: row.summary,
          $description: row.description,
          $location: row.location,
          $status: row.status,
          $dtstart: row.dtstart,
          $dtend: row.dtend,
          $date_only: row.date_only,
          $room: row.room,
          $checkin: row.checkin,
          $checkout: row.checkout,
          $nights: row.nights,
          $first_seen: row.first_seen,
          $last_seen: row.last_seen,
        });
      }
    })();
  }

  /** Drop everything about a feed - called when a chat stops watching it. */
  forgetFeed(feedId: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM events WHERE feed_id = ?").run(feedId);
      this.db.prepare("DELETE FROM feed_state WHERE feed_id = ?").run(feedId);
    })();
  }

  close(): void {
    this.db.close();
  }
}
