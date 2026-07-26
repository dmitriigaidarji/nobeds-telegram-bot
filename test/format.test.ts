import { describe, expect, test } from "bun:test";
import { parseIcs } from "../src/ical.ts";
import {
  escapeHtml,
  formatAvailability,
  formatCancelled,
  formatCreated,
  formatStayLine,
  formatUpcoming,
} from "../src/format.ts";
import { chunk } from "../src/notifier.ts";
import { detailsFromEvent } from "../src/booking.ts";
import { buildAvailability } from "../src/availability.ts";
import type { StoredEvent } from "../src/store.ts";
import { nobedsIcs, testConfig } from "./helpers.ts";

// Deliberately a negative-offset zone: a date-only value rendered in local
// time here would show the previous day.
const config = testConfig({ timezone: "America/New_York" });

const nobeds = await Bun.file(
  new URL("./fixtures/nobeds.ics", import.meta.url),
).text();
const generic = await Bun.file(
  new URL("./fixtures/sample.ics", import.meta.url),
).text();

function stored(partial: Partial<StoredEvent>): StoredEvent {
  return {
    feedId: 1,
    key: "k",
    uid: null,
    hash: "",
    summary: null,
    description: null,
    location: null,
    status: null,
    dtstart: null,
    dtend: null,
    dateOnly: true,
    room: null,
    checkIn: null,
    checkOut: null,
    nights: null,
    firstSeen: "",
    lastSeen: "",
    ...partial,
  };
}

describe("booking messages", () => {
  test("leads with the room, then the guest and the stay", () => {
    const events = parseIcs(nobeds);
    const message = formatCreated(events[1]!, config);

    expect(message).toContain("🆕 <b>New booking</b>");
    expect(message).toContain("🏠 <b>A1 Room 2</b>");
    expect(message).toContain("👤 Mira Kovac");
    expect(message).toContain("26 Jul 2026");
    expect(message).toContain("3 nights");
    expect(message).toContain("📍 12 04 Riverside Tower, 8 Market St");
  });

  test("never dumps the raw DESCRIPTION key block at the reader", () => {
    const message = formatCreated(parseIcs(nobeds)[0]!, config);

    expect(message).not.toContain("CHECKIN:");
    expect(message).not.toContain("PROPERTY:");
    expect(message).not.toContain("NIGHTS:");
  });

  test("renders date-only stays in UTC, without an off-by-one day", () => {
    const [first] = parseIcs(generic);
    const stay = formatStayLine(detailsFromEvent(first!), config)!;

    expect(stay).toContain("3 Aug 2026");
    expect(stay).toContain("7 Aug 2026");
    expect(stay).toContain("4 nights");
  });

  test("escapes HTML so a guest name cannot break the message", () => {
    expect(escapeHtml("Tom & <b>Jerry</b>")).toBe(
      "Tom &amp; &lt;b&gt;Jerry&lt;/b&gt;",
    );

    const ics = nobedsIcs([
      {
        room: "A1",
        guest: "Tom & <b>Jerry</b>",
        checkIn: "2026-08-03",
        checkOut: "2026-08-05",
      },
    ]);
    const message = formatCreated(parseIcs(ics)[0]!, config);
    expect(message).toContain("Tom &amp; &lt;b&gt;Jerry&lt;/b&gt;");
    expect(message).not.toContain("<b>Jerry");
  });

  test("surfaces unmodelled fields rather than dropping them", () => {
    // The generic fixture carries an X- property and a differently shaped
    // description - both still have to reach the reader.
    const message = formatCreated(parseIcs(generic)[0]!, config);
    expect(message).toContain("X-NOBEDS-CHANNEL: Booking.com");
    expect(message).toContain("NB-100234");
  });

  test("a cancellation reads back the same booking from the snapshot", () => {
    const message = formatCancelled(
      stored({
        summary: "Mira Kovac",
        description:
          "CHECKIN:2026-07-26\nCHECKOUT:2026-07-29\nNIGHTS:3\nPROPERTY:A1 Room 2",
        room: "A1 Room 2",
        checkIn: "2026-07-26",
        checkOut: "2026-07-29",
      }),
      config,
    );

    expect(message).toContain("❌ <b>Booking cancelled</b>");
    expect(message).toContain("A1 Room 2");
    expect(message).toContain("Mira Kovac");
    expect(message).toContain("26 Jul 2026");
  });
});

/** Bookings as the commands see them: parsed straight from a live fetch. */
function details(ics: string) {
  return parseIcs(ics).map(detailsFromEvent);
}

describe("formatUpcoming", () => {
  test("lists arrivals with room and nights", () => {
    const message = formatUpcoming(
      details(
        nobedsIcs([
          {
            room: "A1 Room 2",
            guest: "Mira Kovac",
            checkIn: "2026-07-26",
            checkOut: "2026-07-29",
          },
        ]),
      ),
      config,
      10,
    );

    expect(message).toContain("Next arrivals");
    expect(message).toContain("Mira Kovac");
    expect(message).toContain("A1 Room 2");
    expect(message).toContain("3n");
  });

  test("says so plainly when there is nothing", () => {
    expect(formatUpcoming([], config, 10)).toContain("No upcoming bookings");
  });

  test("truncates a long list and says how many are hidden", () => {
    const bookings = details(
      nobedsIcs(
        Array.from({ length: 12 }, (_, i) => ({
          room: "A1",
          guest: `Guest ${i}`,
          checkIn: `2026-08-${String(i + 1).padStart(2, "0")}`,
          checkOut: `2026-08-${String(i + 2).padStart(2, "0")}`,
        })),
      ),
    );
    expect(formatUpcoming(bookings, config, 10)).toContain("and 2 more");
  });
});

describe("formatAvailability", () => {
  const bookings = details(
    nobedsIcs([
      {
        room: "A1 Room 2",
        guest: "Mira Kovac",
        checkIn: "2026-07-26",
        checkOut: "2026-07-29",
      },
      {
        room: "A1 room1",
        guest: "Nobody",
        checkIn: "2026-08-20",
        checkOut: "2026-08-22",
      },
    ]),
  );

  test("names what is free tonight and lists the gaps", () => {
    const report = buildAvailability(bookings, {
      days: 14,
      timezone: "UTC",
      now: new Date("2026-07-26T09:00:00Z"),
    });
    const message = formatAvailability(report, config);

    expect(message).toContain("🛏 <b>Availability</b>");
    expect(message).toContain("Free tonight:");
    expect(message).toContain("A1 room1");
    expect(message).not.toMatch(/Free tonight:.*A1 Room 2/);
    expect(message).toContain("Mira Kovac");
  });

  test("explains itself when no booking has ever been seen", () => {
    const report = buildAvailability([], { days: 7, timezone: "UTC" });
    expect(formatAvailability(report, config)).toContain(
      "I haven't seen a single booking yet",
    );
  });
});

describe("chunk", () => {
  test("leaves a short message alone", () => {
    expect(chunk("hello", 100)).toEqual(["hello"]);
  });

  test("splits on line boundaries and respects the limit", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const parts = chunk(text, 60);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(60);
    expect(parts.join("\n")).toBe(text);
  });

  test("hard-splits a single oversized line", () => {
    const parts = chunk("x".repeat(250), 100);
    expect(parts).toHaveLength(3);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(100);
  });
});
