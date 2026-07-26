import type { Config } from "./config.ts";
import { redactUrl } from "./config.ts";
import { fetchIcal } from "./fetcher.ts";
import { IcsParseError, parseIcs } from "./ical.ts";
import { diffBookings, toCurrentBooking } from "./diff.ts";
import type { CurrentBooking } from "./diff.ts";
import { formatCancelled, formatCreated, formatModified } from "./format.ts";
import { isChatGone } from "./notifier.ts";
import type { Notifier } from "./notifier.ts";
import type { Feed, FeedStore, SnapshotStore } from "./store.ts";
import { expiryWarning, inspectToken } from "./token.ts";

export interface PollOutcome {
  status: "ok" | "unchanged" | "seeded" | "failed" | "suspicious" | "skipped";
  created: number;
  modified: number;
  cancelled: number;
  detail?: string;
}

const EMPTY: Omit<PollOutcome, "status"> = {
  created: 0,
  modified: 0,
  cancelled: 0,
};

export class Poller {
  constructor(
    private config: Config,
    private feeds: FeedStore,
    private snapshots: SnapshotStore,
    private notifier: Notifier,
  ) {}

  /**
   * Send to the feed's chat, and switch its feeds off if the chat is gone for
   * good. Without this, a user who blocks the bot is polled forever.
   */
  private async notify(feed: Feed, text: string): Promise<void> {
    try {
      await this.notifier.send(feed.chatId, text);
    } catch (error) {
      if (isChatGone(error)) {
        const reason =
          error instanceof Error ? error.message : "chat unreachable";
        console.warn(`[poll] chat ${feed.chatId} unreachable, disabling feeds`);
        this.feeds.disableChat(feed.chatId, reason);
        return;
      }
      throw error;
    }
  }

  /** Warn about the impending token expiry at most once per escalation bucket. */
  private async checkToken(feed: Feed, warnedBucket: string | null): Promise<void> {
    const info = inspectToken(feed.url);
    if (!info) return;

    const warning = expiryWarning(info);
    if (!warning) return;
    if (warnedBucket === warning.bucket) return;

    await this.notify(
      feed,
      `${warning.urgent ? "🚨" : "⏳"} <b>iCal link expiry</b>\n\n${warning.text}`,
    );
    this.snapshots.patchState(feed.id, { tokenWarnedBucket: warning.bucket });
  }

  async runOnce(feedId: number): Promise<PollOutcome> {
    const feed = this.feeds.getFeed(feedId);
    if (!feed || feed.disabled) {
      return { status: "skipped", ...EMPTY, detail: "feed gone or disabled" };
    }

    const state = this.snapshots.state(feed.id);
    this.snapshots.patchState(feed.id, {
      lastPollAt: new Date().toISOString(),
    });

    try {
      await this.checkToken(feed, state.tokenWarnedBucket);
    } catch (error) {
      console.error("[poll] token warning failed to send:", error);
    }

    let bookings: CurrentBooking[];
    let etag: string | undefined;
    let lastModified: string | undefined;

    try {
      const result = await fetchIcal(feed.url, {
        etag: state.etag ?? undefined,
        lastModified: state.lastModified ?? undefined,
      });

      if (result.notModified) {
        await this.recordSuccess(feed, state.failureCount);
        return { status: "unchanged", ...EMPTY };
      }

      bookings = parseIcs(result.body ?? "").map(toCurrentBooking);
      etag = result.etag;
      lastModified = result.lastModified;
    } catch (error) {
      return await this.recordFailure(feed, state.failureCount, error);
    }

    const previous = this.snapshots.eventsForFeed(feed.id);

    // A feed that suddenly returns nothing is far more likely to be an outage,
    // a truncated response, or a login redirect than a genuine mass
    // cancellation. Refuse to act on it and keep the last known-good snapshot.
    if (bookings.length === 0 && previous.size > 0) {
      if (!state.emptyAlertedAt) {
        await this.notify(
          feed,
          `⚠️ <b>Feed returned zero bookings</b>\n\nThe NoBeds feed parsed fine but contained no events, while ${previous.size} booking(s) are being tracked. Treating this as an error rather than mass cancellation, so nothing was changed. Will keep polling.`,
        );
        this.snapshots.patchState(feed.id, {
          emptyAlertedAt: new Date().toISOString(),
        });
      }
      return { status: "suspicious", ...EMPTY, detail: "empty feed ignored" };
    }
    if (state.emptyAlertedAt) {
      this.snapshots.patchState(feed.id, { emptyAlertedAt: null });
    }

    const diff = diffBookings(bookings, previous, {
      graceDays: this.config.cancelGraceDays,
    });

    const snapshot = bookings.map((booking) => ({
      event: booking.event,
      details: booking.details,
    }));

    // First poll against an empty snapshot: adopt whatever is already on the
    // books without narrating it, or the bot's first act is one message per
    // stay. This also runs after the /tmp snapshot is cleared by a reboot,
    // which is why that loss is quiet rather than a burst of fake bookings.
    const firstRun = state.seededAt === null;
    if (firstRun && !this.config.notifyOnFirstRun) {
      this.snapshots.applySnapshot(feed.id, snapshot, diff.removedKeys);
      this.snapshots.patchState(feed.id, {
        seededAt: new Date().toISOString(),
        etag: etag ?? null,
        lastModified: lastModified ?? null,
      });
      await this.recordSuccess(feed, state.failureCount);
      await this.notify(
        feed,
        `✅ <b>Watching this link</b>\n\nSeeded with ${bookings.length} existing booking(s). You'll get a message here when a booking is created, changed, or cancelled.\n\nTry /availability to see what's free.`,
      );
      return { status: "seeded", ...EMPTY, created: bookings.length };
    }

    for (const booking of diff.created) {
      await this.notify(feed, formatCreated(booking.event, this.config));
    }
    for (const change of diff.modified) {
      await this.notify(
        feed,
        formatModified(change.event, change.changes, this.config),
      );
    }
    for (const stored of diff.cancelled) {
      await this.notify(feed, formatCancelled(stored, this.config));
    }

    // Persisted only after every notification is out. If sending throws, the
    // snapshot stays put and the next poll retries the same diff - duplicates
    // are recoverable, a silently swallowed booking is not.
    this.snapshots.applySnapshot(feed.id, snapshot, diff.removedKeys);
    this.snapshots.patchState(feed.id, {
      etag: etag ?? null,
      lastModified: lastModified ?? null,
      ...(firstRun ? { seededAt: new Date().toISOString() } : {}),
    });

    const changeCount =
      diff.created.length + diff.modified.length + diff.cancelled.length;
    if (changeCount > 0) {
      this.snapshots.patchState(feed.id, {
        lastChangeAt: new Date().toISOString(),
      });
    }
    await this.recordSuccess(feed, state.failureCount);

    return {
      status: "ok",
      created: diff.created.length,
      modified: diff.modified.length,
      cancelled: diff.cancelled.length,
    };
  }

  private async recordSuccess(feed: Feed, failures: number): Promise<void> {
    this.snapshots.patchState(feed.id, {
      failureCount: 0,
      lastError: null,
      lastSuccessAt: new Date().toISOString(),
    });

    if (failures >= this.config.failureAlertThreshold) {
      await this.notify(
        feed,
        `✅ <b>Feed recovered</b>\n\nBack in contact with the NoBeds feed after ${failures} failed attempt(s).`,
      );
    }
  }

  private async recordFailure(
    feed: Feed,
    previousFailures: number,
    error: unknown,
  ): Promise<PollOutcome> {
    const failures = previousFailures + 1;
    const reason =
      error instanceof Error ? error.message : redactUrl(String(error));
    this.snapshots.patchState(feed.id, {
      failureCount: failures,
      lastError: reason,
    });

    console.error(`[poll] feed ${feed.id} failure ${failures}: ${reason}`);

    // Alert on crossing the threshold, then only on every 12th failure after,
    // so a long outage doesn't turn into a stream of identical messages.
    const threshold = this.config.failureAlertThreshold;
    const shouldAlert =
      failures === threshold ||
      (failures > threshold && (failures - threshold) % 12 === 0);

    if (shouldAlert) {
      const hint =
        error instanceof IcsParseError
          ? "\n\nThe feed responded but the body wasn't iCalendar - the export link may have been revoked. Send me a fresh one with /add."
          : "";
      await this.notify(
        feed,
        `⚠️ <b>Cannot reach the NoBeds feed</b>\n\n${failures} consecutive failures.\n\n<code>${reason.replace(/[<>&]/g, "")}</code>${hint}`,
      ).catch((sendError) =>
        console.error("[poll] failure alert failed to send:", sendError),
      );
    }

    return { status: "failed", ...EMPTY, detail: reason };
  }
}
