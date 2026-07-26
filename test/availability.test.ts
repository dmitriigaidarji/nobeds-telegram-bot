import { describe, expect, test } from "bun:test";
import { buildAvailability } from "../src/availability.ts";
import type { StoredEvent } from "../src/store.ts";

function booking(
  room: string | null,
  checkIn: string,
  checkOut: string,
  guest = "Guest",
): StoredEvent {
  return {
    feedId: 1,
    key: `${room}|${checkIn}`,
    uid: null,
    hash: "",
    summary: guest,
    description: null,
    location: null,
    status: null,
    dtstart: null,
    dtend: null,
    dateOnly: true,
    room,
    checkIn,
    checkOut,
    nights: null,
    firstSeen: "",
    lastSeen: "",
  };
}

const NOW = new Date("2026-07-26T09:00:00Z");
const OPTIONS = { days: 14, timezone: "UTC", now: NOW };

describe("buildAvailability", () => {
  test("spans the window it was asked for", () => {
    const report = buildAvailability([], OPTIONS);
    expect(report.from).toBe("2026-07-26");
    expect(report.to).toBe("2026-08-09");
    expect(report.nights).toBe(14);
  });

  test("a room with no bookings is free for the whole window", () => {
    const report = buildAvailability(
      [booking("A1", "2026-09-01", "2026-09-03")],
      OPTIONS,
    );
    const room = report.rooms[0]!;

    expect(room.fullyFree).toBe(true);
    expect(room.freeNights).toBe(14);
    expect(room.freeTonight).toBe(true);
  });

  test("splits the window around a stay", () => {
    const report = buildAvailability(
      [booking("A1", "2026-07-29", "2026-08-01")],
      OPTIONS,
    );
    const room = report.rooms[0]!;

    expect(room.free).toEqual([
      { start: "2026-07-26", end: "2026-07-29" },
      { start: "2026-08-01", end: "2026-08-09" },
    ]);
    expect(room.freeNights).toBe(11);
    expect(room.freeTonight).toBe(true);
  });

  test("the checkout day is free again, so a same-day turnaround shows free", () => {
    // Out on the 29th, in on the 29th: the room is never idle, and there must
    // be no phantom gap between the two stays.
    const report = buildAvailability(
      [
        booking("A1", "2026-07-26", "2026-07-29", "First"),
        booking("A1", "2026-07-29", "2026-07-31", "Second"),
      ],
      OPTIONS,
    );
    const room = report.rooms[0]!;

    expect(room.free).toEqual([{ start: "2026-07-31", end: "2026-08-09" }]);
    expect(room.freeTonight).toBe(false);
  });

  test("a stay covering the whole window leaves no free nights", () => {
    const report = buildAvailability(
      [booking("A1", "2026-07-01", "2026-09-01")],
      OPTIONS,
    );
    const room = report.rooms[0]!;

    expect(room.free).toEqual([]);
    expect(room.freeNights).toBe(0);
    expect(room.fullyFree).toBe(false);
    expect(room.freeTonight).toBe(false);
  });

  test("clamps a stay that starts before the window", () => {
    const report = buildAvailability(
      [booking("A1", "2026-07-20", "2026-07-28")],
      OPTIONS,
    );
    const room = report.rooms[0]!;

    expect(room.freeTonight).toBe(false);
    expect(room.free).toEqual([{ start: "2026-07-28", end: "2026-08-09" }]);
  });

  test("ignores stays entirely outside the window", () => {
    const report = buildAvailability(
      [booking("A1", "2026-06-01", "2026-06-05")],
      OPTIONS,
    );
    expect(report.rooms[0]!.fullyFree).toBe(true);
  });

  test("groups rooms case-insensitively but keeps a readable label", () => {
    const report = buildAvailability(
      [
        booking("A1 Room 2", "2026-07-26", "2026-07-28"),
        booking("a1 room 2", "2026-08-01", "2026-08-03"),
      ],
      OPTIONS,
    );

    expect(report.rooms).toHaveLength(1);
    expect(report.rooms[0]!.room).toBe("A1 Room 2");
    expect(report.rooms[0]!.booked).toHaveLength(2);
  });

  test("counts bookings that name no room instead of silently dropping them", () => {
    const report = buildAvailability(
      [booking(null, "2026-07-27", "2026-07-29")],
      OPTIONS,
    );

    expect(report.rooms).toHaveLength(0);
    expect(report.unassigned).toBe(1);
  });

  test("sorts rooms the way a human numbers them", () => {
    const report = buildAvailability(
      [
        booking("Room 10", "2026-09-01", "2026-09-02"),
        booking("Room 2", "2026-09-01", "2026-09-02"),
      ],
      OPTIONS,
    );
    expect(report.rooms.map((room) => room.room)).toEqual(["Room 2", "Room 10"]);
  });
});
