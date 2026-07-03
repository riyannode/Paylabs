/**
 * Tavily Search Client
 *
 * Minimal HTTP client for Tavily Search API.
 * Used as secondary web search when RSSHub returns 0 AI/Crypto sources.
 *
 * POST /search — Search API only. No Crawl, Extract, or Map.
 *
 * Safe:
 * - reads TAVILY_API_KEY from env, never logs it
 * - timeout with AbortController
 * - returns safe fields only
 * - never returns raw Tavily payload
 * - never logs raw payload
 */

// ─── Types ──────────────────────────────────────────────────

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  published_date?: string | null;
}

export interface TavilySearchResponse {
  ok: boolean;
  results: TavilySearchResult[];
  result_count: number;
  latency_ms: number;
  error_class: string | null;
}

// ─── Config ─────────────────────────────────────────────────

function getTavilyConfig() {
  return {
    apiKey: process.env.TAVILY_API_KEY || "",
    enabled: process.env.PAYLABS_TAVILY_ENABLED === "true",
    maxResults: Math.min(Number(process.env.PAYLABS_TAVILY_MAX_RESULTS) || 5, 20),
    timeoutMs: Math.min(Number(process.env.PAYLABS_TAVILY_TIMEOUT_MS) || 8000, 15000),
    searchDepth: (process.env.PAYLABS_TAVILY_SEARCH_DEPTH || "basic") as
      | "basic"
      | "advanced"
      | "fast"
      | "ultra-fast",
  };
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Check if Tavily is enabled and configured.
 * Safe to call on every request — no network, no side effects.
 */
export function isTavilyEnabled(): boolean {
  const config = getTavilyConfig();
  return config.enabled && config.apiKey.length > 0;
}

/**
 * Execute a Tavily Search query.
 * Returns normalized results — never raw Tavily payload.
 *
 * @param query — safe query string (already sanitized by caller)
 * @returns TavilySearchResponse with safe fields only
 */
export async function tavilySearch(query: string): Promise<TavilySearchResponse> {
  const config = getTavilyConfig();

  if (!config.enabled || !config.apiKey) {
    return {
      ok: false,
      results: [],
      result_count: 0,
      latency_ms: 0,
      error_class: "tavily_disabled",
    };
  }

  if (!query || query.trim().length === 0) {
    return {
      ok: false,
      results: [],
      result_count: 0,
      latency_ms: 0,
      error_class: "empty_query",
    };
  }

  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        query: query.trim(),
        search_depth: config.searchDepth,
        max_results: config.maxResults,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const elapsed = Date.now() - start;

    if (!response.ok) {
      // Safe log — status only, no body
      console.warn(JSON.stringify({
        log: "[tavily_client] search_failed",
        status: response.status,
        latency_ms: elapsed,
        error_class: `http_${response.status}`,
      }));
      return {
        ok: false,
        results: [],
        result_count: 0,
        latency_ms: elapsed,
        error_class: `http_${response.status}`,
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();
    const rawResults: any[] = Array.isArray(data?.results) ? data.results : [];

    // Extract safe fields only — never forward raw payload
    const safeResults: TavilySearchResult[] = rawResults
      .filter((r) => r && typeof r === "object")
      .map((r) => ({
        title: String(r.title || ""),
        url: String(r.url || ""),
        content: String(r.content || ""),
        score: typeof r.score === "number" ? r.score : 0.5,
        published_date: r.published_date ? String(r.published_date) : null,
      }));

    // Safe log — no query, no raw payload
    console.log(JSON.stringify({
      log: "[tavily_client] search_complete",
      result_count: safeResults.length,
      latency_ms: elapsed,
      domains: safeResults
        .map((r) => {
          try { return new URL(r.url).hostname; } catch { return ""; }
        })
        .filter(Boolean)
        .slice(0, 5),
    }));

    return {
      ok: true,
      results: safeResults,
      result_count: safeResults.length,
      latency_ms: elapsed,
      error_class: null,
    };
  } catch (err: unknown) {
    clearTimeout(timeout);
    const elapsed = Date.now() - start;
    const errorClass =
      err instanceof Error && err.name === "AbortError"
        ? "timeout"
        : err instanceof Error
          ? err.message.slice(0, 80)
          : "unknown";

    console.warn(JSON.stringify({
      log: "[tavily_client] search_error",
      latency_ms: elapsed,
      error_class: errorClass,
    }));

    return {
      ok: false,
      results: [],
      result_count: 0,
      latency_ms: elapsed,
      error_class: errorClass,
    };
  }
}
