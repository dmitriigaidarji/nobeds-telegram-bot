import type { VEvent } from "./ical.ts";
import { hashEvent } from "./store.ts";
import type { StoredEvent } from "./store.ts";
import type { BookingDetails } from "./booking.ts";
import {
  bookingIdentityKey,
  bookingKey,
  describeBooking,
  detailsFromEvent,
  isoToMs,
} from "./booking.ts";

export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

/** A booking as it appears in the current snapshot, with its derived identity. */
export interface CurrentBooking {
  key: string;
  event: VEvent;
  details: BookingDetails;
}

export interface ModifiedBooking {
  key: string;
  /** Set when the booking was matched under a different key (dates moved). */
  previousKey?: string;
  event: VEvent;
  details: BookingDetails;
  previous: StoredEvent;
  changes: FieldChange[];
}

export interface BookingDiff {
  created: CurrentBooking[];
  modified: ModifiedBooking[];
  cancelled: StoredEvent[];
  /** Vanished from the feed but already checked out - aged out, not cancelled. */
  agedOut: StoredEvent[];
  /** Keys to delete: cancellations, age-outs, and re-keyed bookings. */
  removedKeys: string[];
}

export function toCurrentBooking(event: VEvent): CurrentBooking {
  const details = detailsFromEvent(event);
  return { key: bookingKey(details), event, details };
}

/**
 * A stored row is structurally a BookingSource, so the same derivation runs
 * over live events and over the snapshot - one place where SUMMARY becomes a
 * guest name and PROPERTY becomes a room.
 */
export function detailsFromStored(stored: StoredEvent): BookingDetails {
  return describeBooking(stored);
}

function describe(value: string | number | null | undefined): string {
  const text = String(value ?? "").trim();
  return text === "" ? "(not set)" : text;
}

/**
 * Compare the fields a host would notice, not the raw iCal properties. The
 * structured DESCRIPTION keys are compared individually so a message says
 * "Check-out: 2026-07-29 → 2026-07-31" instead of diffing an opaque blob.
 */
function changedFields(
  previous: StoredEvent,
  next: BookingDetails,
  nextStatus?: string,
): FieldChange[] {
  const before = detailsFromStored(previous);
  const pairs: Array<
    [string, string | number | null | undefined, string | number | undefined]
  > = [
    ["Guest", before.guest, next.guest],
    ["Room", before.room, next.room],
    ["Check-in", before.checkIn, next.checkIn],
    ["Check-out", before.checkOut, next.checkOut],
    ["Nights", before.nights, next.nights],
    ["Guest address", before.address, next.address],
    // Absent from NoBeds' own export, but other iCal producers do send it.
    ["Status", previous.status, nextStatus],
  ];

  const changes: FieldChange[] = [];
  for (const [field, from, to] of pairs) {
    if (String(from ?? "") !== String(to ?? "")) {
      changes.push({ field, before: describe(from), after: describe(to) });
    }
  }

  // Anything else NoBeds put in DESCRIPTION, compared key by key.
  const beforeExtras = new Map(before.extras.map((e) => [e.key, e.value]));
  const afterExtras = new Map(next.extras.map((e) => [e.key, e.value]));
  for (const key of new Set([...beforeExtras.keys(), ...afterExtras.keys()])) {
    const from = beforeExtras.get(key) ?? "";
    const to = afterExtras.get(key) ?? "";
    if (from !== to) {
      changes.push({ field: key, before: describe(from), after: describe(to) });
    }
  }

  return changes;
}

function checkoutMs(stored: StoredEvent): number | undefined {
  const iso = stored.checkOut ?? stored.checkIn;
  if (iso) {
    const ms = isoToMs(iso);
    if (ms !== undefined) return ms;
  }
  const raw = stored.dtend ?? stored.dtstart;
  const match = raw ? /^(\d{4})(\d{2})(\d{2})/.exec(raw) : null;
  if (!match) return undefined;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * Derive booking events by diffing the new snapshot against the stored one.
 *
 * iCal is a *state* feed, not an event stream, so this is where events come
 * from. The upside is that it is self-healing: a missed or failed poll costs
 * nothing because the next successful one still sees the full picture.
 *
 * Two subtleties:
 *
 * - Identity is content-derived (room + check-in), because NoBeds hands out a
 *   fresh random UID on every request. A booking whose check-in moved therefore
 *   changes key, so unmatched bookings get a second pass keyed on room + guest
 *   before anything is called a cancellation.
 * - Disappearance is ambiguous. A booking absent from the feed has either been
 *   cancelled or simply scrolled out of NoBeds' export window. Announcing the
 *   latter as a cancellation would be actively misleading, so a booking that
 *   already checked out more than `graceDays` ago is filed as aged out and
 *   reported to nobody.
 */
export function diffBookings(
  current: CurrentBooking[],
  previous: Map<string, StoredEvent>,
  options: { graceDays: number; now?: Date },
): BookingDiff {
  const now = options.now ?? new Date();
  const graceMs = options.graceDays * 86_400_000;

  const created: CurrentBooking[] = [];
  const modified: ModifiedBooking[] = [];
  const unmatched: CurrentBooking[] = [];
  const leftovers = new Map(previous);

  for (const booking of current) {
    const prior = leftovers.get(booking.key);
    if (!prior) {
      unmatched.push(booking);
      continue;
    }
    leftovers.delete(booking.key);
    if (prior.hash !== hashEvent(booking.event)) {
      modified.push({
        key: booking.key,
        event: booking.event,
        details: booking.details,
        previous: prior,
        changes: changedFields(prior, booking.details, booking.event.status),
      });
    }
  }

  // Second pass: same room and guest, different dates. Without this, moving a
  // check-in by a day reads as a cancellation plus an unrelated new booking.
  const byIdentity = new Map<string, StoredEvent[]>();
  for (const stored of leftovers.values()) {
    const identity = bookingIdentityKey(detailsFromStored(stored));
    if (!identity) continue;
    const bucket = byIdentity.get(identity);
    if (bucket) bucket.push(stored);
    else byIdentity.set(identity, [stored]);
  }

  const removedKeys: string[] = [];
  for (const booking of unmatched) {
    const identity = bookingIdentityKey(booking.details);
    const candidates = identity ? byIdentity.get(identity) : undefined;
    const prior = candidates?.shift();
    if (!prior) {
      created.push(booking);
      continue;
    }
    leftovers.delete(prior.key);
    removedKeys.push(prior.key);
    modified.push({
      key: booking.key,
      previousKey: prior.key,
      event: booking.event,
      details: booking.details,
      previous: prior,
      changes: changedFields(prior, booking.details, booking.event.status),
    });
  }

  const cancelled: StoredEvent[] = [];
  const agedOut: StoredEvent[] = [];
  for (const stored of leftovers.values()) {
    const checkout = checkoutMs(stored);
    if (checkout !== undefined && checkout < now.getTime() - graceMs) {
      agedOut.push(stored);
    } else {
      cancelled.push(stored);
    }
    removedKeys.push(stored.key);
  }

  return { created, modified, cancelled, agedOut, removedKeys };
}
