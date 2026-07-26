/**
 * Builders that mimic the real NoBeds export, including the two traits that
 * shaped the design: a KEY:value DESCRIPTION block, and a fresh random UID on
 * every render of the same booking.
 */
import type { Config } from "../src/config.ts";

export interface BookingSpec {
  room: string;
  guest: string;
  /** ISO check-in, e.g. "2026-08-03". */
  checkIn: string;
  checkOut: string;
  address?: string;
  /** Force a UID; by default a new random one is emitted every render. */
  uid?: string;
}

let uidCounter = 0;

function compact(iso: string): string {
  return iso.replace(/-/g, "");
}

function nights(checkIn: string, checkOut: string): number {
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Render bookings the way NoBeds does, with churning UIDs and DTSTAMPs. */
export function nobedsIcs(
  bookings: BookingSpec[],
  options: { stamp?: string } = {},
): string {
  const stamp = options.stamp ?? "20260726T190254Z";
  return [
    "BEGIN:VCALENDAR",
    "PRODID:-//github.com/rianjs/ical.net//NONSGML ical.net 4.0//EN",
    "VERSION:2.0",
    ...bookings.flatMap((booking) => [
      "BEGIN:VEVENT",
      "CLASS:PUBLIC",
      `CREATED:${stamp}`,
      `DESCRIPTION:CHECKIN:${booking.checkIn}\\nCHECKOUT:${booking.checkOut}\\nNIGHTS:${nights(
        booking.checkIn,
        booking.checkOut,
      )}\\nPROPERTY:${booking.room}`,
      `DTEND;VALUE=DATE:${compact(booking.checkOut)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(booking.checkIn)}`,
      `LOCATION:${booking.address ?? ""}`,
      "SEQUENCE:0",
      `SUMMARY:${booking.guest}`,
      `UID:${booking.uid ?? `gen-${++uidCounter}-${Math.random().toString(16).slice(2)}`}`,
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].join("\r\n");
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    botToken: "",
    pollIntervalMs: 300_000,
    dbPath: ":memory:",
    snapshotPath: ":memory:",
    notifyOnFirstRun: false,
    timezone: "Europe/Vilnius",
    locale: "en-GB",
    cancelGraceDays: 2,
    failureAlertThreshold: 3,
    maxFeedsPerChat: 10,
    availabilityDays: 14,
    allowedHosts: ["nobeds.app", "nobeds.com"],
    ...overrides,
  };
}
