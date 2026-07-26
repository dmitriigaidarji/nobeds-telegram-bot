/**
 * Minimal RFC 5545 parser, scoped to what a booking export needs.
 *
 * Hand-rolled rather than pulled from npm because the awkward parts here are
 * few (line folding, quoted parameters, TEXT escaping) and we need to keep
 * every property we don't recognise: NoBeds' exact field layout is unverified,
 * so unknown properties are preserved in `raw` and surfaced to the user rather
 * than dropped on the floor.
 */

export interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface IcsDate {
  /** Original iCal value, e.g. "20260803" or "20260803T140000Z". */
  raw: string;
  /** True for VALUE=DATE (no time component) - the usual case for stay dates. */
  dateOnly: boolean;
  /** TZID parameter when present. */
  tzid?: string;
  /** Date-only values are anchored at UTC midnight so day arithmetic is exact. */
  date: Date;
}

export interface VEvent {
  uid: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  sequence?: number;
  dtstart?: IcsDate;
  dtend?: IcsDate;
  /** Every property in the VEVENT, unescaped, keyed by uppercased name. */
  raw: Record<string, string>;
}

/**
 * Undo RFC 5545 line folding: a CRLF followed by a single space or tab is a
 * continuation of the previous line, not a new one.
 */
function unfold(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (out.length > 0 && (line.startsWith(" ") || line.startsWith("\t"))) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Split on `sep`, ignoring separators inside double-quoted parameter values. */
function splitUnquoted(input: string, sep: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of input) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === sep && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function stripQuotes(value: string): string {
  return value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1)
    : value;
}

/** Unescape a TEXT value: \n \N -> newline, and \\ \, \; -> literal. */
export function unescapeText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      const next = value[++i];
      if (next === "n" || next === "N") out += "\n";
      else if (next === "\\" || next === "," || next === ";") out += next;
      else out += next;
    } else {
      out += ch;
    }
  }
  return out;
}

export function parseLine(line: string): IcsProperty | null {
  if (line.trim() === "") return null;

  let colon = -1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon === -1) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segments = splitUnquoted(head, ";");
  const name = (segments[0] ?? "").trim().toUpperCase();
  if (name === "") return null;

  const params: Record<string, string> = {};
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    params[segment.slice(0, eq).trim().toUpperCase()] = stripQuotes(
      segment.slice(eq + 1).trim(),
    );
  }

  return { name, params, value };
}

/**
 * Parse DATE (`20260803`) and DATE-TIME (`20260803T140000Z`, or floating/TZID
 * `20260803T140000`) forms.
 *
 * Date-only values are anchored at UTC midnight and must be *rendered* in UTC
 * too, otherwise a checkout in a negative-offset timezone displays as the day
 * before. Floating times are treated the same way: we show the wall-clock time
 * the property manager typed, which is what matters for a stay.
 */
export function parseIcsDate(prop: IcsProperty): IcsDate | undefined {
  const raw = prop.value.trim();
  const tzid = prop.params.TZID;

  const dateMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (dateMatch && (prop.params.VALUE === "DATE" || raw.length === 8)) {
    const [, y, m, d] = dateMatch;
    return {
      raw,
      dateOnly: true,
      tzid,
      date: new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))),
    };
  }

  const dtMatch = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(raw);
  if (dtMatch) {
    const [, y, m, d, hh, mm, ss] = dtMatch;
    return {
      raw,
      dateOnly: false,
      tzid,
      date: new Date(
        Date.UTC(
          Number(y),
          Number(m) - 1,
          Number(d),
          Number(hh),
          Number(mm),
          Number(ss),
        ),
      ),
    };
  }

  const fallback = new Date(raw);
  if (!Number.isNaN(fallback.getTime())) {
    return { raw, dateOnly: false, tzid, date: fallback };
  }
  return undefined;
}

export class IcsParseError extends Error {}

/**
 * Extract every VEVENT from an iCalendar document.
 *
 * Throws if the payload is not iCalendar at all - that means the feed returned
 * an error page or a login redirect, which must be treated as a failed poll
 * rather than "zero bookings".
 */
export function parseIcs(text: string): VEvent[] {
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    const preview = text.slice(0, 200).replace(/\s+/g, " ").trim();
    throw new IcsParseError(
      `Response is not an iCalendar document (no BEGIN:VCALENDAR). First 200 chars: ${preview}`,
    );
  }

  const events: VEvent[] = [];
  let current: VEvent | null = null;
  let anonymousCount = 0;

  for (const line of unfold(text)) {
    const prop = parseLine(line);
    if (!prop) continue;

    if (prop.name === "BEGIN" && prop.value.toUpperCase() === "VEVENT") {
      current = { uid: "", raw: {} };
      continue;
    }

    if (prop.name === "END" && prop.value.toUpperCase() === "VEVENT") {
      if (current) {
        // A UID is mandatory per RFC, but never trust a third-party feed to
        // supply one. Fall back to something stable and content-derived so a
        // missing UID doesn't collapse every event into a single record.
        if (current.uid === "") {
          current.uid = `nouid-${anonymousCount++}-${
            current.dtstart?.raw ?? ""
          }-${current.summary ?? ""}`;
        }
        events.push(current);
      }
      current = null;
      continue;
    }

    if (!current) continue;

    const text_ = unescapeText(prop.value);
    current.raw[prop.name] = text_;

    switch (prop.name) {
      case "UID":
        current.uid = text_.trim();
        break;
      case "SUMMARY":
        current.summary = text_.trim();
        break;
      case "DESCRIPTION":
        current.description = text_.trim();
        break;
      case "LOCATION":
        current.location = text_.trim();
        break;
      case "STATUS":
        current.status = text_.trim().toUpperCase();
        break;
      case "SEQUENCE": {
        const n = Number.parseInt(text_.trim(), 10);
        if (!Number.isNaN(n)) current.sequence = n;
        break;
      }
      case "DTSTART":
        current.dtstart = parseIcsDate(prop);
        break;
      case "DTEND":
        current.dtend = parseIcsDate(prop);
        break;
    }
  }

  return events;
}

/** Whole nights between check-in and check-out (DTEND is exclusive). */
export function nightCount(event: VEvent): number | undefined {
  if (!event.dtstart || !event.dtend) return undefined;
  const ms = event.dtend.date.getTime() - event.dtstart.date.getTime();
  if (ms <= 0) return undefined;
  return Math.round(ms / 86_400_000);
}
