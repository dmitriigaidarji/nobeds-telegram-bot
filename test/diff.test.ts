import { describe, expect, test } from "bun:test";
import { parseIcs } from "../src/ical.ts";
import { diffBookings, toCurrentBooking } from "../src/diff.ts";
import type { CurrentBooking } from "../src/diff.ts";
import { hashEvent } from "../src/store.ts";
import type { StoredEvent } from "../src/store.ts";
import { detailsFromEvent } from "../src/booking.ts";
import { nobedsIcs } from "./helpers.ts";
import type { BookingSpec } from "./helpers.ts";

function current(bookings: BookingSpec[]): CurrentBooking[] {
  return parseIcs(nobedsIcs(bookings)).map(toCurrentBooking);
}

/** The snapshot the store would hold after seeing `bookings`. */
function snapshot(bookings: BookingSpec[]): Map<string, StoredEvent> {
  const now = new Date().toISOString();
  return new Map(
    parseIcs(nobedsIcs(bookings)).map((event) => {
      const details = detailsFromEvent(event);
      const booking = toCurrentBooking(event);
      return [
        booking.key,
        {
          feedId: 1,
          key: booking.key,
          uid: event.uid,
          hash: hashEvent(event),
          summary: event.summary ?? null,
          description: event.description ?? null,
          location: event.location ?? null,
          status: event.status ?? null,
          dtstart: event.dtstart?.raw ?? null,
          dtend: event.dtend?.raw ?? null,
          dateOnly: event.dtstart?.dateOnly ?? false,
          room: details.room ?? null,
          checkIn: details.checkIn ?? null,
          checkOut: details.checkOut ?? null,
          nights: details.nights ?? null,
          firstSeen: now,
          lastSeen: now,
        } satisfies StoredEvent,
      ];
    }),
  );
}

const NOW = new Date("2026-07-26T12:00:00Z");
const OPTIONS = { graceDays: 2, now: NOW };

const AUGUST: BookingSpec = {
  room: "A1 Room 2",
  guest: "John Smith",
  checkIn: "2026-08-03",
  checkOut: "2026-08-07",
};
const SEPTEMBER: BookingSpec = {
  room: "A1 Room 3",
  guest: "Ana Petrova",
  checkIn: "2026-09-01",
  checkOut: "2026-09-03",
};

describe("diffBookings", () => {
  test("reports a booking that was not there before", () => {
    const diff = diffBookings(current([AUGUST]), new Map(), OPTIONS);

    expect(diff.created).toHaveLength(1);
    expect(diff.created[0]!.details.guest).toBe("John Smith");
    expect(diff.modified).toHaveLength(0);
    expect(diff.cancelled).toHaveLength(0);
  });

  test("stays quiet when the same bookings come back with new UIDs", () => {
    // The regression that matters most: NoBeds hands out a fresh random UID for
    // every booking on every request. Keying on UID reported the entire feed as
    // cancelled and recreated on each poll.
    const before = snapshot([AUGUST, SEPTEMBER]);
    const after = current([AUGUST, SEPTEMBER]);

    const uidsBefore = [...before.values()].map((event) => event.uid);
    const uidsAfter = after.map((booking) => booking.event.uid);
    expect(uidsAfter).not.toEqual(uidsBefore);

    const diff = diffBookings(after, before, OPTIONS);
    expect(diff.created).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
    expect(diff.cancelled).toHaveLength(0);
  });

  test("ignores CREATED/DTSTAMP churn, which the feed rewrites every fetch", () => {
    const before = snapshot([AUGUST]);
    const after = parseIcs(
      nobedsIcs([AUGUST], { stamp: "20260726T230000Z" }),
    ).map(toCurrentBooking);

    expect(diffBookings(after, before, OPTIONS).modified).toHaveLength(0);
  });

  test("reports an extended stay as a modification, with the field list", () => {
    const diff = diffBookings(
      current([{ ...AUGUST, checkOut: "2026-08-09" }]),
      snapshot([AUGUST]),
      OPTIONS,
    );

    expect(diff.created).toHaveLength(0);
    expect(diff.cancelled).toHaveLength(0);
    expect(diff.modified).toHaveLength(1);

    const changes = diff.modified[0]!.changes;
    expect(changes.find((c) => c.field === "Check-out")).toEqual({
      field: "Check-out",
      before: "2026-08-07",
      after: "2026-08-09",
    });
    expect(changes.find((c) => c.field === "Nights")?.after).toBe("6");
  });

  test("a moved check-in is a modification, not a cancel plus a new booking", () => {
    // Check-in is part of the identity, so this booking arrives under a new
    // key; the second matching pass has to recognise it by room and guest.
    const diff = diffBookings(
      current([{ ...AUGUST, checkIn: "2026-08-04", checkOut: "2026-08-08" }]),
      snapshot([AUGUST]),
      OPTIONS,
    );

    expect(diff.created).toHaveLength(0);
    expect(diff.cancelled).toHaveLength(0);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0]!.previousKey).toBeDefined();
    // The row under the old key has to go, or the booking exists twice.
    expect(diff.removedKeys).toContain(diff.modified[0]!.previousKey!);
    expect(diff.modified[0]!.changes.find((c) => c.field === "Check-in")?.after).toBe(
      "2026-08-04",
    );
  });

  test("a different guest in the same room is a new booking, not a rename", () => {
    const diff = diffBookings(
      current([{ ...AUGUST, guest: "Someone Else", checkIn: "2026-08-20", checkOut: "2026-08-22" }]),
      snapshot([AUGUST]),
      OPTIONS,
    );

    expect(diff.created).toHaveLength(1);
    expect(diff.cancelled).toHaveLength(1);
    expect(diff.modified).toHaveLength(0);
  });

  test("treats a vanished future booking as a cancellation", () => {
    const diff = diffBookings([], snapshot([AUGUST]), OPTIONS);

    expect(diff.cancelled).toHaveLength(1);
    expect(diff.cancelled[0]!.summary).toBe("John Smith");
    expect(diff.agedOut).toHaveLength(0);
    expect(diff.removedKeys).toHaveLength(1);
  });

  test("does not cry cancellation over a booking that simply aged out", () => {
    // Checked out in January; disappearing now means the export window moved
    // on, not that a guest cancelled a stay six months in the past.
    const old: BookingSpec = {
      room: "A1 room1",
      guest: "Past Guest",
      checkIn: "2026-01-10",
      checkOut: "2026-01-14",
    };
    const diff = diffBookings([], snapshot([old]), OPTIONS);

    expect(diff.cancelled).toHaveLength(0);
    expect(diff.agedOut).toHaveLength(1);
    // Aged-out rows are still dropped from the snapshot, just not announced.
    expect(diff.removedKeys).toHaveLength(1);
  });

  test("still reports a cancellation inside the grace window", () => {
    const recent: BookingSpec = {
      room: "A1 room1",
      guest: "Recent Guest",
      checkIn: "2026-07-22",
      checkOut: "2026-07-25",
    };
    const diff = diffBookings([], snapshot([recent]), OPTIONS);

    expect(diff.cancelled).toHaveLength(1);
    expect(diff.agedOut).toHaveLength(0);
  });

  test("handles a mixed round of changes at once", () => {
    const gone: BookingSpec = {
      room: "A1 room1",
      guest: "Gone Guest",
      checkIn: "2026-09-10",
      checkOut: "2026-09-12",
    };
    const fresh: BookingSpec = {
      room: "A1 room1",
      guest: "New Guest",
      checkIn: "2026-10-01",
      checkOut: "2026-10-05",
    };

    const diff = diffBookings(
      current([AUGUST, { ...SEPTEMBER, checkOut: "2026-09-05" }, fresh]),
      snapshot([AUGUST, SEPTEMBER, gone]),
      OPTIONS,
    );

    expect(diff.created.map((b) => b.details.guest)).toEqual(["New Guest"]);
    expect(diff.modified.map((m) => m.details.guest)).toEqual(["Ana Petrova"]);
    expect(diff.cancelled.map((s) => s.summary)).toEqual(["Gone Guest"]);
  });
});
