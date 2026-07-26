/**
 * Dry-run inspector: fetch (or read) the feed, dump what the parser sees, and
 * render the Telegram message each event would produce.
 *
 * Touches neither the database nor Telegram, so it is safe to run against
 * production at any time. Use it to diagnose the feed when its field layout
 * changes and a notification renders incorrectly.
 *
 *   bun run src/inspect.ts                 # uses NOBEDS_ICAL_URL
 *   bun run src/inspect.ts <url>           # uses any iCal URL
 *   bun run src/inspect.ts ./sample.ics    # uses a local file
 *   bun run src/inspect.ts --raw           # also dumps the raw body
 */
import { parseIcs } from "./ical.ts";
import { formatAvailability, formatCreated } from "./format.ts";
import { redactUrl } from "./config.ts";
import { inspectToken } from "./token.ts";
import { bookingKey, detailsFromEvent } from "./booking.ts";
import { buildAvailability } from "./availability.ts";
import type { Config } from "./config.ts";

const previewConfig: Config = {
  botToken: "",
  pollIntervalMs: 300_000,
  dbPath: ":memory:",
  snapshotPath: ":memory:",
  notifyOnFirstRun: false,
  timezone: process.env.DISPLAY_TIMEZONE?.trim() || "Europe/Vilnius",
  locale: process.env.DISPLAY_LOCALE?.trim() || "en-GB",
  cancelGraceDays: 2,
  failureAlertThreshold: 3,
  maxFeedsPerChat: 10,
  availabilityDays: 14,
  allowedHosts: ["nobeds.app", "nobeds.com"],
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const showRaw = args.includes("--raw");
  const target = args.find((arg) => !arg.startsWith("--"));
  const url =
    target && /^https?:\/\//i.test(target)
      ? target
      : target
        ? undefined
        : process.env.NOBEDS_ICAL_URL?.trim();

  let body: string;
  if (!url) {
    if (!target) {
      console.error(
        "Set NOBEDS_ICAL_URL, or pass a URL or a path to a saved .ics file.\n" +
          "  bun run src/inspect.ts ./sample.ics",
      );
      process.exit(1);
    }
    body = await Bun.file(target).text();
    console.log(`Source: file ${target}\n`);
  } else {
    console.log(`Source: ${redactUrl(url)}`);
    const response = await fetch(url, {
      headers: { Accept: "text/calendar, */*;q=0.5" },
      signal: AbortSignal.timeout(30_000),
    });
    console.log(`HTTP ${response.status} ${response.statusText}`);
    // ETag / Last-Modified decide whether polling can be conditional.
    for (const header of ["content-type", "etag", "last-modified"]) {
      const value = response.headers.get(header);
      if (value) console.log(`  ${header}: ${value}`);
    }
    const token = inspectToken(url);
    if (token) {
      console.log(
        `  token expires: ${token.expiresAt.toISOString()} (${token.daysRemaining} days)`,
      );
    }
    console.log();
    if (!response.ok) {
      console.error(await response.text());
      process.exit(1);
    }
    body = await response.text();
  }

  if (showRaw) {
    console.log("──────── raw body ────────");
    console.log(body);
    console.log("──────────────────────────\n");
  }

  const events = parseIcs(body);
  console.log(`Parsed ${events.length} VEVENT(s), ${body.length} bytes\n`);

  // Which properties actually appear, and how often. This is the fastest way
  // to see whether the guest name, room, or channel are in the feed.
  const propertyCounts = new Map<string, number>();
  for (const event of events) {
    for (const name of Object.keys(event.raw)) {
      propertyCounts.set(name, (propertyCounts.get(name) ?? 0) + 1);
    }
  }
  console.log("Properties present:");
  for (const [name, count] of [...propertyCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name.padEnd(24)} ${count}/${events.length}`);
  }
  console.log();

  for (const [index, event] of events.slice(0, 5).entries()) {
    const details = detailsFromEvent(event);
    console.log(`──────── event ${index + 1} ────────`);
    console.log(`UID:      ${event.uid}  (NoBeds regenerates this every fetch)`);
    console.log(`KEY:      ${bookingKey(details)}`);
    console.log(`ROOM:     ${details.room ?? "-"}`);
    console.log(`GUEST:    ${details.guest ?? "-"}`);
    console.log(
      `STAY:     ${details.checkIn ?? "-"} → ${details.checkOut ?? "-"} (${details.nights ?? "?"} nights)`,
    );
    console.log(`ADDRESS:  ${details.address ?? "-"}`);
    if (details.extras.length > 0) {
      console.log(
        `EXTRAS:   ${details.extras.map((e) => `${e.key}=${e.value}`).join(", ")}`,
      );
    }
    console.log("\nTelegram message would read:\n");
    console.log(formatCreated(event, previewConfig));
    console.log();
  }

  if (events.length > 5) {
    console.log(`… ${events.length - 5} more event(s) not shown.\n`);
  }

  // Availability comes straight from the parsed bookings, exactly as the
  // /availability command computes it from a live fetch.
  console.log("──────── /availability would read ────────\n");
  console.log(
    formatAvailability(
      buildAvailability(events.map(detailsFromEvent), {
        days: previewConfig.availabilityDays,
        timezone: previewConfig.timezone,
      }),
      previewConfig,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
