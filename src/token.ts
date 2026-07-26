/**
 * The NoBeds iCal URL embeds an HS256 JWT with an `exp` claim, typically one
 * year out. It is signed by NoBeds, so it cannot be refreshed from here - it
 * has to be regenerated in the panel.
 *
 * Left unwatched, that is the single most likely way this bot dies quietly:
 * the token lapses, every poll 401s, and nobody notices until a guest turns up
 * unannounced. So we decode it and nag well ahead of time.
 */

export interface TokenInfo {
  expiresAt: Date;
  daysRemaining: number;
}

function decodeSegment(segment: string): unknown {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  return JSON.parse(Buffer.from(withPadding, "base64").toString("utf8"));
}

/** Pull the JWT out of the URL path and read its expiry. Best effort. */
export function inspectToken(url: string): TokenInfo | undefined {
  const match = /([A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/.exec(
    url,
  );
  if (!match?.[1]) return undefined;

  const parts = match[1].split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;

  try {
    const payload = decodeSegment(parts[1]);
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("exp" in payload) ||
      typeof (payload as { exp: unknown }).exp !== "number"
    ) {
      return undefined;
    }
    const expiresAt = new Date((payload as { exp: number }).exp * 1000);
    const daysRemaining = Math.floor(
      (expiresAt.getTime() - Date.now()) / 86_400_000,
    );
    return { expiresAt, daysRemaining };
  } catch {
    return undefined;
  }
}

/**
 * Escalating reminder schedule. Returns a bucket key so the caller can send
 * each warning once instead of on every poll.
 */
export function expiryWarning(
  info: TokenInfo,
): { bucket: string; urgent: boolean; text: string } | undefined {
  const days = info.daysRemaining;

  if (days < 0) {
    return {
      bucket: "expired",
      urgent: true,
      text: `The NoBeds iCal token expired on ${info.expiresAt.toISOString().slice(0, 10)}. Booking notifications are stopped until you generate a new export URL in Channels → iCal Export and update NOBEDS_ICAL_URL.`,
    };
  }
  if (days <= 7) {
    return {
      bucket: `d${days}`,
      urgent: true,
      text: `The NoBeds iCal token expires in ${days} day${days === 1 ? "" : "s"} (${info.expiresAt.toISOString().slice(0, 10)}). Generate a new export URL in Channels → iCal Export and update NOBEDS_ICAL_URL.`,
    };
  }
  if (days <= 30) {
    return {
      bucket: "d30",
      urgent: false,
      text: `Heads up: the NoBeds iCal token expires in ${days} days (${info.expiresAt.toISOString().slice(0, 10)}). Worth regenerating it in Channels → iCal Export before it lapses.`,
    };
  }
  return undefined;
}
