/**
 * RSSHub Client
 *
 * Fetches and parses RSS/Atom feeds from RSSHub instances.
 * No LLM calls. No secrets printed. Timeout after 10s.
 */

import Parser from "rss-parser";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ITEMS_DEFAULT = 25;

export interface NormalizedFeedItem {
  title: string;
  canonical_url: string;
  summary: string;
  author_name: string;
  publisher: string;
  published_at: string | null;
  tags: string[];
  raw: Record<string, unknown>;
}

export interface FetchRouteResult {
  ok: true;
  items: NormalizedFeedItem[];
  feed_title: string | null;
}

export interface FetchRouteError {
  ok: false;
  error: string;
}

export type FetchRouteResponse = FetchRouteResult | FetchRouteError;

/**
 * Validate URL is https (except localhost/dev).
 */
export function isValidFeedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    }
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Build the full RSSHub feed URL from base + route path.
 */
export function buildFeedUrl(baseUrl: string, routePath: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return `${base}${path}`;
}

/**
 * Fetch and parse an RSSHub route into normalized feed items.
 */
export async function fetchRoute(
  baseUrl: string,
  routePath: string,
  maxItems?: number
): Promise<FetchRouteResponse> {
  const feedUrl = buildFeedUrl(baseUrl, routePath);
  const limit = maxItems ?? MAX_ITEMS_DEFAULT;

  if (!isValidFeedUrl(baseUrl)) {
    return { ok: false, error: `Invalid base URL: ${baseUrl}` };
  }

  const parser = new Parser({
    timeout: DEFAULT_TIMEOUT_MS,
    headers: {
      "User-Agent": "PayLabs/0.1 RSSHub-Client",
    },
  });

  let feed: Parser.Output<Record<string, unknown>>;
  try {
    feed = await parser.parseURL(feedUrl);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Fetch failed for ${feedUrl}: ${msg}` };
  }

  const items: NormalizedFeedItem[] = (feed.items ?? [])
    .slice(0, limit)
    .map((item) => normalizeItem(item, feedUrl));

  return {
    ok: true,
    items,
    feed_title: feed.title ?? null,
  };
}

function normalizeItem(
  item: Parser.Item,
  feedUrl: string
): NormalizedFeedItem {
  const canonicalUrl = item.link || item.guid || feedUrl;
  const tags = Array.isArray(item.categories)
    ? item.categories.filter(Boolean).map(String)
    : [];

  return {
    title: item.title ?? "(untitled)",
    canonical_url: canonicalUrl,
    summary: item.contentSnippet ?? item.content ?? item.summary ?? "",
    author_name: item.creator ?? "",
    publisher: item.creator ?? "",
    published_at: item.isoDate ?? item.pubDate ?? null,
    tags,
    raw: item as Record<string, unknown>,
  };
}
