import { loadConfig, redactUrl } from "./config.ts";
import { FeedStore, SnapshotStore } from "./store.ts";
import { BOT_COMMANDS, createBot } from "./bot.ts";
import { Notifier } from "./notifier.ts";
import { Poller } from "./poller.ts";
import { registerFeed } from "./feeds.ts";
import { createSerialQueue } from "./serial.ts";

let stopping = false;
let wake: (() => void) | null = null;

function interruptibleSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new FeedStore(config.dbPath);
  const snapshots = new SnapshotStore(config.snapshotPath);

  // Every poll - scheduled, on-add, or requested with /poll - runs through this
  // queue, so no two overlap. See src/serial.ts.
  const serialise = createSerialQueue();

  // Feeds added from Telegram are polled straight away rather than waiting out
  // the interval: the reply says "watching", so it had better be watching.
  const pending: number[] = [];
  const bot = createBot(config, store, snapshots, {
    onFeedAdded: (feedId) => {
      pending.push(feedId);
      wake?.();
    },
    pollNow: (feedIds) =>
      serialise(async () => {
        const outcomes = [];
        for (const feedId of feedIds) {
          outcomes.push(await poller.runOnce(feedId));
        }
        return outcomes;
      }),
  });
  const notifier = new Notifier(bot);
  const poller = new Poller(config, store, snapshots, notifier);

  // Fail fast on a bad token rather than looping silently against a dead bot.
  const me = await bot.api.getMe();
  console.log(`[bot] running as @${me.username}`);
  await bot.api.setMyCommands(BOT_COMMANDS).catch((error) => {
    console.warn("[bot] could not publish command list:", error.message);
  });

  if (config.bootstrap) {
    const { chatId, icalUrl } = config.bootstrap;
    const result = await registerFeed(store, config, chatId, icalUrl, {
      probe: false,
    });
    console.log(
      result.ok
        ? `[bootstrap] feed ${result.feed.id} for chat ${chatId}: ${redactUrl(icalUrl)}`
        : `[bootstrap] rejected NOBEDS_ICAL_URL: ${result.reason}`,
    );
  }

  // Long polling for commands runs alongside the feed poller. Not awaited:
  // bot.start() only settles on shutdown.
  void bot.start({ drop_pending_updates: true });

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[main] ${signal} received, shutting down`);
    wake?.();
    void bot.stop().finally(() => {
      store.close();
      snapshots.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log(
    `[poll] every ${Math.round(config.pollIntervalMs / 1000)}s, feeds=${store.countFeeds()}`,
  );
  console.log(
    `[store] links=${config.dbPath} (persistent) · snapshot=${config.snapshotPath} (disposable)`,
  );

  const pollFeed = async (feedId: number): Promise<void> => {
    try {
      const outcome = await serialise(() => poller.runOnce(feedId));
      if (outcome.status === "ok" || outcome.status === "seeded") {
        console.log(
          `[poll] feed ${feedId} ${outcome.status}: +${outcome.created} ~${outcome.modified} -${outcome.cancelled}`,
        );
      } else {
        console.log(
          `[poll] feed ${feedId} ${outcome.status}${outcome.detail ? `: ${outcome.detail}` : ""}`,
        );
      }
    } catch (error) {
      // runOnce handles feed failures itself; reaching here means something
      // unexpected broke. Log and keep the loop alive rather than exiting.
      console.error(`[poll] feed ${feedId} unexpected error:`, error);
    }
  };

  let nextTickAt = 0;
  while (!stopping) {
    if (Date.now() >= nextTickAt) {
      // Feeds are polled one at a time. A host has a handful of links, and
      // serialising keeps both NoBeds and Telegram's rate limits comfortable.
      for (const feed of store.activeFeeds()) {
        if (stopping) break;
        await pollFeed(feed.id);
      }
      nextTickAt = Date.now() + config.pollIntervalMs;
    }

    // A wake-up can mean "a chat just added a link" rather than "the interval
    // elapsed" - poll that one now without disturbing the tick schedule.
    while (pending.length > 0 && !stopping) {
      await pollFeed(pending.shift()!);
    }

    if (stopping) break;
    const waitMs = Math.max(0, nextTickAt - Date.now());
    if (waitMs > 0) await interruptibleSleep(waitMs);
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? `Fatal: ${error.message}` : "Fatal:",
    error,
  );
  process.exit(1);
});
