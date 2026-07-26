export interface Config {
  botToken: string;
  /**
   * Optional single-tenant bootstrap. When both NOBEDS_ICAL_URL and
   * TELEGRAM_CHAT_ID are set, that pair is registered as a feed on startup so
   * an existing deployment keeps working without anyone touching Telegram.
   * Everything else is added at runtime, per chat, via /start.
   */
  bootstrap?: { icalUrl: string; chatId: string };
  pollIntervalMs: number;
  /** Persistent: the registered iCal links, and nothing else. */
  dbPath: string;
  /**
   * Disposable: last-poll bookings, used only to diff one poll against the
   * next. Defaults under /tmp, so guest data never lands on the persistent
   * volume and a reboot wipes it. Losing it costs notifications for changes
   * made while the bot was down, nothing more.
   */
  snapshotPath: string;
  notifyOnFirstRun: boolean;
  timezone: string;
  locale: string;
  cancelGraceDays: number;
  failureAlertThreshold: number;
  maxFeedsPerChat: number;
  availabilityDays: number;
  /** Hostnames a chat is allowed to register. Keeps the bot from being used
   *  as a general-purpose URL fetcher by strangers. */
  allowedHosts: string[];
}

class ConfigError extends Error {}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigError(`Missing required env var ${name}`);
  return value;
}

function optionalNumber(name: string, fallback: number, min: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ConfigError(`${name} must be a number, got "${raw}"`);
  }
  if (value < min) {
    throw new ConfigError(`${name} must be at least ${min}, got ${value}`);
  }
  return value;
}

function optionalBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

const DEFAULT_ALLOWED_HOSTS = ["nobeds.app", "nobeds.com"];

export function loadConfig(): Config {
  const icalUrl = process.env.NOBEDS_ICAL_URL?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

  const allowedHosts = (process.env.ALLOWED_ICAL_HOSTS?.trim() || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== "");

  const config: Config = {
    botToken: required("TELEGRAM_BOT_TOKEN"),
    // Floor of 60s: the feed is a static export and polling harder buys
    // nothing but load on someone else's server.
    pollIntervalMs: optionalNumber("POLL_INTERVAL_SECONDS", 300, 60) * 1000,
    dbPath: process.env.DB_PATH?.trim() || "./data/feeds.db",
    snapshotPath:
      process.env.SNAPSHOT_PATH?.trim() || "/tmp/nobeds-snapshot.db",
    notifyOnFirstRun: optionalBoolean("NOTIFY_ON_FIRST_RUN", false),
    timezone: process.env.DISPLAY_TIMEZONE?.trim() || "Europe/Vilnius",
    locale: process.env.DISPLAY_LOCALE?.trim() || "en-GB",
    cancelGraceDays: optionalNumber("CANCEL_GRACE_DAYS", 2, 0),
    failureAlertThreshold: optionalNumber("FAILURE_ALERT_THRESHOLD", 3, 1),
    maxFeedsPerChat: optionalNumber("MAX_FEEDS_PER_CHAT", 10, 1),
    availabilityDays: optionalNumber("AVAILABILITY_DAYS", 14, 1),
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : DEFAULT_ALLOWED_HOSTS,
  };

  // The env pair is a convenience, not a requirement: chats register their own
  // links at runtime. A half-filled pair is therefore a warning, not a fatal
  // error - refusing to boot over it would take a working bot offline.
  if (icalUrl && !icalUrl.includes("REPLACE_WITH_YOUR_TOKEN")) {
    if (!/^https?:\/\//i.test(icalUrl)) {
      throw new ConfigError("NOBEDS_ICAL_URL must be an http(s) URL");
    }
    if (chatId) {
      config.bootstrap = { icalUrl, chatId };
    } else {
      console.warn(
        "[config] NOBEDS_ICAL_URL is set but TELEGRAM_CHAT_ID is empty, so it can't be pre-registered. Send the link to the bot with /start instead.",
      );
    }
  }

  return config;
}

export interface UrlCheck {
  ok: boolean;
  url?: string;
  reason?: string;
}

/**
 * Validate a link someone pasted into a chat.
 *
 * The bot is open to anyone, so this is the only thing standing between it and
 * being used to fetch arbitrary URLs on someone else's behalf: https only, and
 * only hosts on the NoBeds allowlist.
 */
export function checkIcalUrl(raw: string, allowedHosts: string[]): UrlCheck {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "That's not a link." };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "I couldn't read that as a URL." };
  }

  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]";

  // Plain http is allowed only against loopback, and only if loopback was
  // explicitly allowlisted - that's for local development and tests, never for
  // a real link, whose token would otherwise cross the network in the clear.
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    return { ok: false, reason: "The link has to start with <code>https://</code>." };
  }
  const allowed = allowedHosts.some(
    (candidate) => host === candidate || host.endsWith(`.${candidate}`),
  );
  if (!allowed) {
    return {
      ok: false,
      reason: `I only watch NoBeds links (${allowedHosts.join(", ")}). That one points at <code>${host}</code>.`,
    };
  }

  parsed.hash = "";
  return { ok: true, url: parsed.toString() };
}

/** Strip the JWT out of the URL so logs and error messages stay safe to share. */
export function redactUrl(url: string): string {
  return url.replace(
    /([A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g,
    "<token>",
  );
}

/**
 * A form safe to echo into a group chat: host, path shape, and the last few
 * characters so a host with several exports can still tell them apart.
 */
export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.replace(/\/+$/, "").split("/").pop() ?? "";
    const hint = tail.length > 6 ? `…${tail.slice(-6)}` : tail;
    return `${parsed.hostname}/…/${hint}`;
  } catch {
    return redactUrl(url);
  }
}
