/**
 * NoBeds' actual VEVENT layout, verified against a live export:
 *
 *   SUMMARY:Mira Kovac
 *   DESCRIPTION:CHECKIN:2026-07-26\nCHECKOUT:2026-07-29\nNIGHTS:3\nPROPERTY:A1 Room 2
 *   LOCATION:12 04 Riverside Tower\, 8 Market St
 *   DTSTART;VALUE=DATE:20260726
 *   DTEND;VALUE=DATE:20260729
 *
 * Three things about that are worth spelling out, because they drive the whole
 * design:
 *
 * 1. SUMMARY is the guest name, and LOCATION is the *guest's* address - often
 *    empty, sometimes just a country. The room is not in LOCATION; it is the
 *    PROPERTY key inside DESCRIPTION.
 * 2. DESCRIPTION is a KEY:value block, not prose. Dumping it verbatim into a
 *    message (as the first cut did) reads like a debug log.
 * 3. UID is a fresh random GUID on *every* request - the same booking has a
 *    different UID each poll, and CREATED/DTSTAMP are the fetch time. So UID is
 *    useless as an identity, and identity has to be derived from content
 *    instead. See `bookingKey`.
 */

import type { VEvent } from "./ical.ts";

export interface BookingFieldValue {
  key: string;
  value: string;
}

export interface BookingDetails {
  /** SUMMARY - the guest name. */
  guest?: string;
  /** DESCRIPTION PROPERTY - the property + room, e.g. "A1 Room 2". */
  room?: string;
  /** Case- and space-insensitive form of `room`, for grouping and identity. */
  roomKey?: string;
  /** ISO date, from DESCRIPTION CHECKIN, falling back to DTSTART. */
  checkIn?: string;
  /** ISO date, from DESCRIPTION CHECKOUT, falling back to DTEND (exclusive). */
  checkOut?: string;
  nights?: number;
  /** LOCATION - the guest's own address, when they supplied one. */
  address?: string;
  /** DESCRIPTION keys we don't model, kept so a feed change stays visible. */
  extras: BookingFieldValue[];
  /** DESCRIPTION lines that aren't KEY:value at all. */
  notes: string[];
}

/** The subset of a booking that both live events and stored rows can supply. */
export interface BookingSource {
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  /** Raw iCal DTSTART value, e.g. "20260726". */
  dtstart?: string | null;
  dtend?: string | null;
}

/** DESCRIPTION keys rendered explicitly, so they don't also show up as extras. */
const KNOWN_KEYS = new Set(["CHECKIN", "CHECKOUT", "NIGHTS", "PROPERTY"]);

const FIELD_LINE = /^([A-Za-z][A-Za-z0-9 _-]{0,30}):\s*(.*)$/;

function collapseSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function blankToUndefined(value: string | null | undefined): string | undefined {
  const text = (value ?? "").trim();
  return text === "" ? undefined : text;
}

/**
 * Split the DESCRIPTION block into KEY -> value.
 *
 * Only the first colon splits, so a value may itself contain colons. Lines that
 * don't look like a key at all are returned as `notes` rather than dropped - if
 * NoBeds starts putting free text in there, it still reaches the user.
 */
export function parseDescriptionFields(description?: string | null): {
  fields: Map<string, string>;
  notes: string[];
} {
  const fields = new Map<string, string>();
  const notes: string[] = [];
  if (!description) return { fields, notes };

  for (const line of description.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = FIELD_LINE.exec(trimmed);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const key = collapseSpace(match[1]).toUpperCase();
      const value = match[2].trim();
      // Last write wins, but keep the first non-empty value: a repeated key
      // with an empty value shouldn't erase a real one.
      if (value !== "" || !fields.has(key)) fields.set(key, value);
    } else {
      notes.push(trimmed);
    }
  }
  return { fields, notes };
}

/** Normalise "2026-10-10" or "20261010" (or a DATE-TIME) to an ISO date. */
export function toIsoDate(value?: string | null): string | undefined {
  const raw = (value ?? "").trim();
  if (raw === "") return undefined;

  const dashed = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (dashed) return `${dashed[1]}-${dashed[2]}-${dashed[3]}`;

  const compact = /^(\d{4})(\d{2})(\d{2})/.exec(raw);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;

  return undefined;
}

export function describeBooking(source: BookingSource): BookingDetails {
  const { fields, notes } = parseDescriptionFields(source.description);

  const room = blankToUndefined(
    fields.get("PROPERTY") ? collapseSpace(fields.get("PROPERTY")!) : undefined,
  );
  const checkIn = toIsoDate(fields.get("CHECKIN")) ?? toIsoDate(source.dtstart);
  const checkOut = toIsoDate(fields.get("CHECKOUT")) ?? toIsoDate(source.dtend);

  let nights: number | undefined;
  const declared = Number.parseInt(fields.get("NIGHTS") ?? "", 10);
  if (Number.isFinite(declared) && declared > 0) {
    nights = declared;
  } else if (checkIn && checkOut) {
    const span = daysBetween(checkIn, checkOut);
    if (span !== undefined && span > 0) nights = span;
  }

  const extras: BookingFieldValue[] = [];
  for (const [key, value] of fields) {
    if (KNOWN_KEYS.has(key) || value === "") continue;
    extras.push({ key, value });
  }

  return {
    guest: blankToUndefined(source.summary),
    room,
    roomKey: room ? room.toLowerCase() : undefined,
    checkIn,
    checkOut,
    nights,
    address: blankToUndefined(source.location),
    extras,
    notes,
  };
}

export function detailsFromEvent(event: VEvent): BookingDetails {
  return describeBooking({
    summary: event.summary,
    description: event.description,
    location: event.location,
    dtstart: event.dtstart?.raw,
    dtend: event.dtend?.raw,
  });
}

function normaliseName(value?: string): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * A content-derived identity for a booking.
 *
 * Necessary because NoBeds hands out a new random UID on every request. A room
 * can hold exactly one booking starting on a given date, so room + check-in is
 * a natural key: extending a stay or fixing a guest's name then reads as a
 * modification rather than a cancel-and-rebook.
 *
 * Feeds that omit PROPERTY fall back to guest + check-in, and anything with no
 * usable date falls back to the full content so distinct bookings can't
 * collapse into one row.
 */
export function bookingKey(details: BookingDetails): string {
  if (details.roomKey && details.checkIn) {
    return `room:${details.roomKey}|${details.checkIn}`;
  }
  const guest = normaliseName(details.guest);
  if (guest && details.checkIn) return `guest:${guest}|${details.checkIn}`;
  return [
    "raw",
    details.roomKey ?? "",
    guest,
    details.checkIn ?? "",
    details.checkOut ?? "",
    normaliseName(details.address),
  ].join("|");
}

/**
 * Weaker key used to spot the *same* booking after its dates moved: a check-in
 * change alters `bookingKey`, which would otherwise read as a cancellation plus
 * a new booking. Returns undefined when there isn't enough to match on.
 */
export function bookingIdentityKey(details: BookingDetails): string | undefined {
  const guest = normaliseName(details.guest);
  if (!guest) return undefined;
  return `${details.roomKey ?? ""}|${guest}`;
}

/* ---------------------------------------------------------------- dates -- */

/** ISO date -> UTC midnight ms. Date-only values never touch a local offset. */
export function isoToMs(iso: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return undefined;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(ms) ? undefined : ms;
}

export function msToIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDaysIso(iso: string, days: number): string {
  const ms = isoToMs(iso);
  if (ms === undefined) return iso;
  return msToIso(ms + days * 86_400_000);
}

export function daysBetween(from: string, to: string): number | undefined {
  const a = isoToMs(from);
  const b = isoToMs(to);
  if (a === undefined || b === undefined) return undefined;
  return Math.round((b - a) / 86_400_000);
}

/**
 * "Today" at the property, not at the server. A host in Vilnius asking what is
 * free tonight at 01:00 local must not be answered with yesterday's UTC date.
 */
export function todayIso(timezone?: string, now: Date = new Date()): string {
  if (timezone) {
    try {
      // en-CA formats as YYYY-MM-DD, which is exactly the shape we want.
      const formatted = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now);
      if (/^\d{4}-\d{2}-\d{2}$/.test(formatted)) return formatted;
    } catch {
      // Unknown timezone: fall through to UTC rather than throwing at a user.
    }
  }
  return msToIso(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}
