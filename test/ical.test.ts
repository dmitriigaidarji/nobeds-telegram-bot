import { describe, expect, test } from "bun:test";
import { IcsParseError, nightCount, parseIcs, unescapeText } from "../src/ical.ts";

const fixture = await Bun.file(
  new URL("./fixtures/sample.ics", import.meta.url),
).text();

describe("parseIcs", () => {
  test("extracts every VEVENT", () => {
    const events = parseIcs(fixture);
    expect(events).toHaveLength(2);
    expect(events[0]!.uid).toBe("booking-100234@nobeds.app");
    expect(events[1]!.uid).toBe("booking-100235@nobeds.app");
  });

  test("unfolds continuation lines", () => {
    const [first] = parseIcs(fixture);
    // "Guest" + folded "s: 2" must rejoin, not become "Guest s: 2".
    expect(first!.description).toContain("Guests: 2");
    expect(first!.description).not.toContain("Guest s: 2");
  });

  test("unescapes TEXT values", () => {
    const events = parseIcs(fixture);
    expect(events[0]!.description).toContain("\n");
    expect(events[0]!.description?.split("\n")[0]).toBe("Guest: John Smith");
    expect(events[1]!.summary).toBe("Ana Petrova, Suite");
  });

  test("distinguishes DATE from DATE-TIME", () => {
    const events = parseIcs(fixture);
    expect(events[0]!.dtstart?.dateOnly).toBe(true);
    expect(events[0]!.dtstart?.date.toISOString()).toBe(
      "2026-08-03T00:00:00.000Z",
    );
    expect(events[1]!.dtstart?.dateOnly).toBe(false);
    expect(events[1]!.dtstart?.date.toISOString()).toBe(
      "2026-08-10T14:00:00.000Z",
    );
  });

  test("counts nights from an exclusive DTEND", () => {
    const events = parseIcs(fixture);
    expect(nightCount(events[0]!)).toBe(4);
  });

  test("keeps unmodelled properties", () => {
    const [first] = parseIcs(fixture);
    expect(first!.raw["X-NOBEDS-CHANNEL"]).toBe("Booking.com");
  });

  test("handles CRLF line endings", () => {
    const crlf = fixture.replace(/\n/g, "\r\n");
    expect(parseIcs(crlf)).toHaveLength(2);
    expect(parseIcs(crlf)[0]!.description).toContain("Guests: 2");
  });

  test("tolerates quoted parameters containing a colon", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:x1",
      'DTSTART;TZID="Europe/Vilnius:main";VALUE=DATE:20260803',
      "SUMMARY:Odd params",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const [event] = parseIcs(ics);
    expect(event!.dtstart?.raw).toBe("20260803");
    expect(event!.dtstart?.dateOnly).toBe(true);
  });

  test("rejects a non-iCalendar body instead of reporting zero bookings", () => {
    expect(() => parseIcs("<html><body>Login required</body></html>")).toThrow(
      IcsParseError,
    );
  });

  test("gives eventless UIDs distinct fallbacks", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "DTSTART;VALUE=DATE:20260803",
      "SUMMARY:One",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART;VALUE=DATE:20260810",
      "SUMMARY:Two",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const events = parseIcs(ics);
    expect(events).toHaveLength(2);
    expect(events[0]!.uid).not.toBe(events[1]!.uid);
  });
});

describe("unescapeText", () => {
  test("handles the RFC 5545 escape set", () => {
    expect(unescapeText("a\\nb")).toBe("a\nb");
    expect(unescapeText("a\\Nb")).toBe("a\nb");
    expect(unescapeText("a\\,b")).toBe("a,b");
    expect(unescapeText("a\\;b")).toBe("a;b");
    expect(unescapeText("a\\\\b")).toBe("a\\b");
  });

  test("does not re-interpret an escaped backslash", () => {
    expect(unescapeText("a\\\\nb")).toBe("a\\nb");
  });
});
