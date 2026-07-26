import type { IcsDate, VEvent } from "./ical.ts";
import type { FieldChange } from "./diff.ts";
import { detailsFromStored } from "./diff.ts";
import type { StoredEvent } from "./store.ts";
import type { Config } from "./config.ts";
import type { BookingDetails } from "./booking.ts";
import { detailsFromEvent, isoToMs } from "./booking.ts";
import type { AvailabilityReport, DateRange } from "./availability.ts";

/** Properties already rendered explicitly, or pure plumbing not worth showing. */
const BORING_PROPERTIES = new Set([
  "BEGIN",
  "END",
  "UID",
  "SUMMARY",
  "DESCRIPTION",
  "LOCATION",
  "STATUS",
  "DTSTART",
  "DTEND",
  "DTSTAMP",
  "SEQUENCE",
  "CREATED",
  "LAST-MODIFIED",
  "TRANSP",
  "CLASS",
  "PRIORITY",
]);

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Date-only values are rendered in UTC on purpose. They were anchored at UTC
 * midnight during parsing, so formatting them in a negative-offset timezone
 * would display the previous day - a check-in date silently off by one.
 */
export function formatDate(value: IcsDate, config: Config): string {
  const options: Intl.DateTimeFormatOptions = value.dateOnly
    ? {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }
    : {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: value.tzid && !value.raw.endsWith("Z") ? "UTC" : config.timezone,
      };

  try {
    return new Intl.DateTimeFormat(config.locale, options).format(value.date);
  } catch {
    return value.date.toISOString().slice(0, value.dateOnly ? 10 : 16);
  }
}

/** "Sat, 10 Oct 2026" - the check-in/check-out dates are plain calendar dates. */
export function formatIsoDate(
  iso: string,
  config: Config,
  options: { weekday?: boolean; year?: boolean } = {},
): string {
  const ms = isoToMs(iso);
  if (ms === undefined) return iso;
  const { weekday = true, year = true } = options;
  try {
    return new Intl.DateTimeFormat(config.locale, {
      ...(weekday ? { weekday: "short" as const } : {}),
      day: "numeric",
      month: "short",
      ...(year ? { year: "numeric" as const } : {}),
      timeZone: "UTC",
    }).format(new Date(ms));
  } catch {
    return iso;
  }
}

/** "Fri, 10 Oct 2026 → Sun, 12 Oct 2026 · 2 nights" */
export function formatStayLine(
  details: BookingDetails,
  config: Config,
): string | undefined {
  if (!details.checkIn) return undefined;
  const start = formatIsoDate(details.checkIn, config);
  if (!details.checkOut) return start;
  const nights = details.nights;
  const suffix = nights ? ` · ${nights} night${nights === 1 ? "" : "s"}` : "";
  return `${start} → ${formatIsoDate(details.checkOut, config)}${suffix}`;
}

/**
 * Any iCal property we didn't explicitly model. NoBeds' own export has none,
 * but other producers put booking references and channel names in X- fields -
 * show them rather than silently dropping them.
 */
function extraProperties(event: VEvent): string[] {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(event.raw)) {
    if (BORING_PROPERTIES.has(name)) continue;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    lines.push(`${escapeHtml(name)}: ${escapeHtml(trimmed)}`);
  }
  return lines;
}

function detailLines(details: BookingDetails, config: Config): string[] {
  const lines: string[] = [];

  if (details.room) lines.push(`🏠 <b>${escapeHtml(details.room)}</b>`);
  if (details.guest) lines.push(`👤 ${escapeHtml(details.guest)}`);

  const stay = formatStayLine(details, config);
  if (stay) lines.push(`📅 ${escapeHtml(stay)}`);

  if (details.address) lines.push(`📍 ${escapeHtml(details.address)}`);

  for (const extra of details.extras) {
    lines.push(`• ${escapeHtml(extra.key)}: ${escapeHtml(extra.value)}`);
  }
  for (const note of details.notes) lines.push(escapeHtml(note));

  return lines;
}

function bodyLines(event: VEvent, config: Config): string[] {
  const lines = detailLines(detailsFromEvent(event), config);
  const extras = extraProperties(event);
  if (extras.length > 0) lines.push("", ...extras);
  return lines;
}

export function formatCreated(event: VEvent, config: Config): string {
  return ["🆕 <b>New booking</b>", "", ...bodyLines(event, config)].join("\n");
}

export function formatModified(
  event: VEvent,
  changes: FieldChange[],
  config: Config,
): string {
  const lines = ["✏️ <b>Booking changed</b>", "", ...bodyLines(event, config)];
  if (changes.length > 0) {
    lines.push("", "<b>What changed</b>");
    for (const change of changes) {
      lines.push(
        `• ${escapeHtml(change.field)}: ${escapeHtml(change.before)} → ${escapeHtml(change.after)}`,
      );
    }
  }
  return lines.join("\n");
}

export function formatCancelled(stored: StoredEvent, config: Config): string {
  return [
    "❌ <b>Booking cancelled</b>",
    "",
    ...detailLines(detailsFromStored(stored), config),
    "",
    "<i>This booking is no longer in the NoBeds feed.</i>",
  ].join("\n");
}

/* ------------------------------------------------------------ listings -- */

/** "26–29 Jul" or "29 Jul – 2 Aug", for a range whose end is exclusive. */
function formatRange(range: DateRange, config: Config): string {
  const start = formatIsoDate(range.start, config, {
    weekday: false,
    year: false,
  });
  const end = formatIsoDate(range.end, config, { weekday: false, year: false });
  return `${start} → ${end}`;
}

export function formatUpcoming(
  bookings: BookingDetails[],
  config: Config,
  limit: number,
): string {
  if (bookings.length === 0) {
    return "No upcoming bookings in the feed(s) I'm watching for this chat.";
  }

  const lines = ["📅 <b>Next arrivals</b>", ""];
  for (const details of bookings.slice(0, limit)) {
    const when = details.checkIn
      ? formatIsoDate(details.checkIn, config, { year: false })
      : "?";
    const nights = details.nights ? ` · ${details.nights}n` : "";
    const room = details.room ? ` · ${details.room}` : "";
    lines.push(
      `• <b>${escapeHtml(when)}</b>${escapeHtml(nights)} — ${escapeHtml(
        details.guest ?? "(no name)",
      )}${escapeHtml(room)}`,
    );
  }
  if (bookings.length > limit) {
    lines.push("", `<i>… and ${bookings.length - limit} more.</i>`);
  }
  return lines.join("\n");
}

export function formatAvailability(
  report: AvailabilityReport,
  config: Config,
): string {
  const header = `🛏 <b>Availability</b> · ${escapeHtml(
    formatRange({ start: report.from, end: report.to }, config),
  )} (${report.nights} night${report.nights === 1 ? "" : "s"})`;

  if (report.rooms.length === 0) {
    return [
      header,
      "",
      "I haven't seen a single booking yet, so I don't know which rooms exist.",
      "",
      "<i>Rooms are discovered from bookings in the feed - a room that has never been booked can't appear here.</i>",
    ].join("\n");
  }

  const lines = [header, ""];

  const freeTonight = report.rooms.filter((room) => room.freeTonight);
  lines.push(
    freeTonight.length === 0
      ? "🔴 <b>Tonight:</b> everything is booked."
      : `✅ <b>Free tonight:</b> ${escapeHtml(
          freeTonight.map((room) => room.room).join(", "),
        )}`,
    "",
  );

  for (const room of report.rooms) {
    lines.push(`<b>${escapeHtml(room.room)}</b>`);
    if (room.fullyFree) {
      lines.push(`  ✅ free all ${report.nights} nights`);
    } else {
      for (const stay of room.booked) {
        const guest = stay.guest ? ` · ${stay.guest}` : "";
        lines.push(
          `  🔴 ${escapeHtml(formatRange({ start: stay.start, end: stay.end }, config))}${escapeHtml(guest)}`,
        );
      }
      for (const gap of room.free) {
        lines.push(`  ✅ ${escapeHtml(formatRange(gap, config))}`);
      }
      if (room.free.length === 0) {
        lines.push("  🔴 no free nights in this window");
      }
    }
    lines.push("");
  }

  if (report.unassigned > 0) {
    lines.push(
      `<i>${report.unassigned} booking(s) name no room, so they aren't counted above.</i>`,
    );
  }
  lines.push(
    "<i>Rooms are discovered from bookings - a room never booked can't appear here.</i>",
  );

  return lines.join("\n").trimEnd();
}
