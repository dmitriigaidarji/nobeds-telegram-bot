import { redactUrl } from "./config.ts";

export interface FetchResult {
  /** True when the server answered 304 and the body is unchanged. */
  notModified: boolean;
  body?: string;
  etag?: string;
  lastModified?: string;
}

export class FetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ConditionalHeaders {
  etag?: string;
  lastModified?: string;
}

/**
 * Fetch the iCal feed, using conditional-request headers when the server
 * supports them so an unchanged feed costs a 304 instead of a full download.
 */
export async function fetchIcal(
  url: string,
  conditional: ConditionalHeaders,
  timeoutMs = 30_000,
): Promise<FetchResult> {
  const headers: Record<string, string> = {
    Accept: "text/calendar, text/plain;q=0.9, */*;q=0.5",
    "User-Agent": "nobeds-telegram/1.0 (+booking notifier)",
  };
  if (conditional.etag) headers["If-None-Match"] = conditional.etag;
  if (conditional.lastModified) {
    headers["If-Modified-Since"] = conditional.lastModified;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new FetchError(`Network error fetching feed: ${reason}`);
  }

  if (response.status === 304) return { notModified: true };

  if (response.status === 401 || response.status === 403) {
    throw new FetchError(
      `Feed rejected the token (HTTP ${response.status}). The iCal URL has probably expired or been regenerated - check Channels → iCal Export. URL: ${redactUrl(url)}`,
      response.status,
    );
  }

  if (!response.ok) {
    throw new FetchError(
      `Feed returned HTTP ${response.status} ${response.statusText}`,
      response.status,
    );
  }

  const body = await response.text();
  return {
    notModified: false,
    body,
    etag: response.headers.get("etag") ?? undefined,
    lastModified: response.headers.get("last-modified") ?? undefined,
  };
}
