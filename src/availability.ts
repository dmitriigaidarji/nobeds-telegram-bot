/**
 * Availability derived from the booking feed.
 *
 * The export lists *bookings*, never the room inventory, so the set of rooms is
 * whatever has been booked at least once. A room that has never had a booking
 * is invisible here - that is a property of the feed, not a bug, and the
 * rendered message says so.
 *
 * A stay occupies the nights [check-in, check-out); the room is free again on
 * the checkout day, which is why a same-day turnaround shows as available.
 */

import { addDaysIso, daysBetween, isoToMs, todayIso } from "./booking.ts";

/**
 * The only thing availability needs from a booking. Deliberately not tied to a
 * stored row: the commands compute this straight from a live fetch, so nothing
 * has to be on disk for `/availability` to answer.
 */
export interface BookingLike {
  room?: string | null;
  guest?: string | null;
  checkIn?: string | null;
  checkOut?: string | null;
}

export interface Stay {
  start: string;
  end: string;
  guest?: string;
}

export interface DateRange {
  start: string;
  /** Exclusive: a range of one night has end = start + 1 day. */
  end: string;
}

export interface RoomAvailability {
  room: string;
  booked: Stay[];
  free: DateRange[];
  /** Nights free inside the window. */
  freeNights: number;
  /** True when nothing is booked in the whole window. */
  fullyFree: boolean;
  /** True when the room is free for the night starting on `from`. */
  freeTonight: boolean;
}

export interface AvailabilityReport {
  from: string;
  /** Exclusive end of the window. */
  to: string;
  nights: number;
  rooms: RoomAvailability[];
  /** Bookings that named no room, so they can't be attributed. */
  unassigned: number;
}

function clampRange(
  range: DateRange,
  from: string,
  to: string,
): DateRange | undefined {
  const start = isoToMs(range.start) ?? 0;
  const end = isoToMs(range.end) ?? 0;
  const windowStart = isoToMs(from) ?? 0;
  const windowEnd = isoToMs(to) ?? 0;
  const clampedStart = Math.max(start, windowStart);
  const clampedEnd = Math.min(end, windowEnd);
  if (clampedEnd <= clampedStart) return undefined;
  return {
    start: new Date(clampedStart).toISOString().slice(0, 10),
    end: new Date(clampedEnd).toISOString().slice(0, 10),
  };
}

/** Turn a room's stays into the gaps between them, inside [from, to). */
function freeRanges(stays: Stay[], from: string, to: string): DateRange[] {
  const occupied = stays
    .map((stay) => clampRange({ start: stay.start, end: stay.end }, from, to))
    .filter((range): range is DateRange => range !== undefined)
    .sort((a, b) => (isoToMs(a.start) ?? 0) - (isoToMs(b.start) ?? 0));

  const gaps: DateRange[] = [];
  let cursor = from;
  for (const range of occupied) {
    if ((isoToMs(range.start) ?? 0) > (isoToMs(cursor) ?? 0)) {
      gaps.push({ start: cursor, end: range.start });
    }
    if ((isoToMs(range.end) ?? 0) > (isoToMs(cursor) ?? 0)) cursor = range.end;
  }
  if ((isoToMs(to) ?? 0) > (isoToMs(cursor) ?? 0)) {
    gaps.push({ start: cursor, end: to });
  }
  return gaps;
}

export function buildAvailability(
  bookings: BookingLike[],
  options: { days: number; timezone?: string; now?: Date },
): AvailabilityReport {
  const from = todayIso(options.timezone, options.now);
  const to = addDaysIso(from, Math.max(1, options.days));

  const byRoom = new Map<string, { label: string; stays: Stay[] }>();
  let unassigned = 0;

  for (const booking of bookings) {
    const start = booking.checkIn;
    const end = booking.checkOut ?? (start ? addDaysIso(start, 1) : undefined);
    if (!start || !end) continue;

    const room = booking.room?.trim();
    if (!room) {
      unassigned += 1;
      continue;
    }

    const key = room.toLowerCase();
    const entry = byRoom.get(key) ?? { label: room, stays: [] };
    entry.stays.push({ start, end, guest: booking.guest ?? undefined });
    byRoom.set(key, entry);
  }

  const rooms: RoomAvailability[] = [...byRoom.values()]
    .map(({ label, stays }) => {
      const booked = stays
        .map((stay) => ({
          ...stay,
          clamped: clampRange({ start: stay.start, end: stay.end }, from, to),
        }))
        .filter((stay) => stay.clamped !== undefined)
        .sort((a, b) => (isoToMs(a.start) ?? 0) - (isoToMs(b.start) ?? 0))
        .map(({ clamped: _clamped, ...stay }) => stay);

      const free = freeRanges(stays, from, to);
      const freeNights = free.reduce(
        (total, range) => total + (daysBetween(range.start, range.end) ?? 0),
        0,
      );

      return {
        room: label,
        booked,
        free,
        freeNights,
        fullyFree: booked.length === 0,
        freeTonight: free.some((range) => range.start === from),
      };
    })
    .sort((a, b) => a.room.localeCompare(b.room, undefined, { numeric: true }));

  return {
    from,
    to,
    nights: daysBetween(from, to) ?? options.days,
    rooms,
    unassigned,
  };
}
