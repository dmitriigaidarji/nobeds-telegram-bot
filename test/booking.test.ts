/**
 * The schema layer: turning NoBeds' actual VEVENT into a booking a host would
 * recognise, and giving it an identity that survives NoBeds' random UIDs.
 */
import { describe, expect, test } from "bun:test";
import { parseIcs } from "../src/ical.ts";
import {
  addDaysIso,
  bookingIdentityKey,
  bookingKey,
  daysBetween,
  detailsFromEvent,
  parseDescriptionFields,
  todayIso,
  toIsoDate,
} from "../src/booking.ts";
import { nobedsIcs } from "./helpers.ts";

const fixture = await Bun.file(
  new URL("./fixtures/nobeds.ics", import.meta.url),
).text();

describe("describeBooking, against the real NoBeds layout", () => {
  test("reads the room out of DESCRIPTION, not LOCATION", () => {
    const [first] = parseIcs(fixture);
    const details = detailsFromEvent(first!);

    expect(details.room).toBe("A1 room1");
    expect(details.guest).toBe("avery lindqvist");
    // LOCATION is the guest's address here, and it is empty on this booking.
    expect(details.address).toBeUndefined();
  });

  test("rejoins a room name split across a folded line", () => {
    // The live feed folds mid-value: "PROPERTY:A1" + CRLF + " room1".
    const [first] = parseIcs(fixture);
    expect(detailsFromEvent(first!).room).toBe("A1 room1");
    expect(detailsFromEvent(first!).room).not.toContain("\n");
  });

  test("keeps LOCATION as the guest address, separate from the room", () => {
    const events = parseIcs(fixture);
    const details = detailsFromEvent(events[1]!);

    expect(details.room).toBe("A1 Room 2");
    expect(details.address).toBe("12 04 Riverside Tower, 8 Market St");
  });

  test("takes the stay from the DESCRIPTION dates and night count", () => {
    const [first] = parseIcs(fixture);
    const details = detailsFromEvent(first!);

    expect(details.checkIn).toBe("2026-10-10");
    expect(details.checkOut).toBe("2026-10-12");
    expect(details.nights).toBe(2);
  });

  test("falls back to DTSTART/DTEND when DESCRIPTION has no dates", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:x",
      "DTSTART;VALUE=DATE:20260803",
      "DTEND;VALUE=DATE:20260807",
      "SUMMARY:Someone",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const details = detailsFromEvent(parseIcs(ics)[0]!);

    expect(details.checkIn).toBe("2026-08-03");
    expect(details.checkOut).toBe("2026-08-07");
    expect(details.nights).toBe(4);
  });

  test("surfaces DESCRIPTION keys it doesn't model instead of dropping them", () => {
    const ics = nobedsIcs([
      { room: "A1", guest: "Someone", checkIn: "2026-08-03", checkOut: "2026-08-05" },
    ]).replace("PROPERTY:A1", "PROPERTY:A1\\nCHANNEL:Booking.com\\nREF:NB-9");
    const details = detailsFromEvent(parseIcs(ics)[0]!);

    expect(details.extras).toEqual([
      { key: "CHANNEL", value: "Booking.com" },
      { key: "REF", value: "NB-9" },
    ]);
  });
});

describe("parseDescriptionFields", () => {
  test("splits on the first colon only", () => {
    const { fields } = parseDescriptionFields("NOTE:see 12:30 arrival");
    expect(fields.get("NOTE")).toBe("see 12:30 arrival");
  });

  test("keeps free text that isn't a KEY:value line", () => {
    const { fields, notes } = parseDescriptionFields(
      "CHECKIN:2026-08-03\nplease call on arrival",
    );
    expect(fields.get("CHECKIN")).toBe("2026-08-03");
    expect(notes).toEqual(["please call on arrival"]);
  });

  test("tolerates an empty description", () => {
    expect(parseDescriptionFields(undefined).fields.size).toBe(0);
  });
});

describe("bookingKey", () => {
  test("is stable across NoBeds' random UIDs", () => {
    const spec = {
      room: "A1 Room 2",
      guest: "Mira Kovac",
      checkIn: "2026-07-26",
      checkOut: "2026-07-29",
    };
    const first = parseIcs(nobedsIcs([spec]))[0]!;
    const second = parseIcs(nobedsIcs([spec]))[0]!;

    expect(first.uid).not.toBe(second.uid);
    expect(bookingKey(detailsFromEvent(first))).toBe(
      bookingKey(detailsFromEvent(second)),
    );
  });

  test("ignores case and spacing in the room name", () => {
    const a = parseIcs(
      nobedsIcs([{ room: "A1  Room 2", guest: "A", checkIn: "2026-07-26", checkOut: "2026-07-27" }]),
    )[0]!;
    const b = parseIcs(
      nobedsIcs([{ room: "a1 room 2", guest: "A", checkIn: "2026-07-26", checkOut: "2026-07-27" }]),
    )[0]!;

    expect(bookingKey(detailsFromEvent(a))).toBe(bookingKey(detailsFromEvent(b)));
  });

  test("separates two rooms booked from the same date", () => {
    const [a, b] = parseIcs(
      nobedsIcs([
        { room: "A1 Room 2", guest: "A", checkIn: "2026-07-26", checkOut: "2026-07-29" },
        { room: "A1 Room 3", guest: "B", checkIn: "2026-07-26", checkOut: "2026-07-27" },
      ]),
    );

    expect(bookingKey(detailsFromEvent(a!))).not.toBe(
      bookingKey(detailsFromEvent(b!)),
    );
  });

  test("falls back to the guest when the feed names no room", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:x",
      "DTSTART;VALUE=DATE:20260803",
      "DTEND;VALUE=DATE:20260807",
      "SUMMARY:Jane Roe",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(bookingKey(detailsFromEvent(parseIcs(ics)[0]!))).toBe(
      "guest:jane roe|2026-08-03",
    );
  });

  test("identity key ignores the dates, so a moved stay can still be matched", () => {
    const before = parseIcs(
      nobedsIcs([{ room: "A1 Room 2", guest: "Mira Kovac", checkIn: "2026-07-26", checkOut: "2026-07-29" }]),
    )[0]!;
    const after = parseIcs(
      nobedsIcs([{ room: "A1 Room 2", guest: "Mira Kovac", checkIn: "2026-07-27", checkOut: "2026-07-30" }]),
    )[0]!;

    expect(bookingKey(detailsFromEvent(before))).not.toBe(
      bookingKey(detailsFromEvent(after)),
    );
    expect(bookingIdentityKey(detailsFromEvent(before))).toBe(
      bookingIdentityKey(detailsFromEvent(after)),
    );
  });
});

describe("date helpers", () => {
  test("normalises both date shapes NoBeds emits", () => {
    expect(toIsoDate("2026-10-10")).toBe("2026-10-10");
    expect(toIsoDate("20261010")).toBe("2026-10-10");
    expect(toIsoDate("20261010T140000Z")).toBe("2026-10-10");
    expect(toIsoDate("")).toBeUndefined();
    expect(toIsoDate("not a date")).toBeUndefined();
  });

  test("adds days across a month boundary", () => {
    expect(addDaysIso("2026-07-30", 3)).toBe("2026-08-02");
    expect(daysBetween("2026-07-30", "2026-08-02")).toBe(3);
  });

  test("today is the property's date, not the server's", () => {
    // 22:30 UTC on the 26th is already the 27th in Vilnius (UTC+3).
    const late = new Date("2026-07-26T22:30:00Z");
    expect(todayIso("Europe/Vilnius", late)).toBe("2026-07-27");
    expect(todayIso("UTC", late)).toBe("2026-07-26");
  });

  test("falls back to UTC for a timezone Intl doesn't know", () => {
    const noon = new Date("2026-07-26T12:00:00Z");
    expect(todayIso("Not/AZone", noon)).toBe("2026-07-26");
  });
});
