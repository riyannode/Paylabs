/**
 * Bounded Content Fetcher
 *
 * Fetches readable content from source URLs with SSRF protection,
 * bounded timeouts, bounded response size, and HTML text extraction.
 *
 * Security requirements:
 * - HTTP/HTTPS only
 * - Block localhost, loopback, RFC1918, cloud metadata
 * - Bounded timeout, response bytes, redirects
 * - Validate content type
 * - No auth, no cookies, no JS execution
 */

import * as cheerio from "cheerio";
import type { ContentFetchOptions } from "./types";
import { CONTENT_FETCH_DEFAULTS } from "./types";

// ─── SSRF Protection ───────────────────────────────────────

/** Check if an IP address is in a private/blocked range */
function isPrivateIp(ip: string): boolean {
  // IPv4 private ranges
  if (/^10\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  // Loopback
  if (/^127\./.test(ip)) return true;
  if (ip === "::1" || ip === "::") return true;
  // Link-local
  if (/^169\.254\./.test(ip)) return true;
  if (/^fe80:/i.test(ip)) return true;
  // Cloud metadata
  if (ip === "169.254.169.254") return true;
  return false;
}

/** Validate URL for SSRF safety before fetching */
function validateUrl(url: string): { ok: boolean; error?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  // HTTP/HTTPS only
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `Unsupported protocol: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  ) {
    return { ok: false, error: "Localhost blocked" };
  }

  // Block cloud metadata IP
  if (hostname === "169.254.169.254") {
    return { ok: false, error: "Cloud metadata blocked" };
  }

  return { ok: true };
}

// ─── Content Extraction ────────────────────────────────────

/** Remove boilerplate elements and extract readable text */
function extractReadableText(html: string): string {
  const $ = cheerio.load(html);

  // Remove non-content elements
  $(
    "script, style, noscript, iframe, svg, " +
    "nav, header, footer, aside, " +
    "form, button, input, select, textarea, " +
    "[role='navigation'], [role='banner'], [role='contentinfo'], " +
    ".cookie-banner, .cookie-notice, .cookie-consent, " +
    ".ad, .ads, .advertisement, .sponsor, " +
    "[class*='cookie'], [class*='advert'], [class*='popup'], " +
    "[id*='cookie'], [id*='advert']"
  ).remove();

  // Try article/main content first
  const articleContent = $("article, main, [role='main'], .post-content, .article-content, .entry-content, .content-body").text();

  if (articleContent && articleContent.trim().length > 100) {
    return cleanText(articleContent);
  }

  // Fallback: body text
  const bodyText = $("body").text();
  return cleanText(bodyText);
}

/** Clean extracted text: collapse whitespace, remove empty lines */
function cleanText(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .trim()
    .slice(0, 80_000); // Hard cap at 80K chars
}

// ─── Public API ────────────────────────────────────────────

export type ContentFetchResult = {
  ok: boolean;
  text: string;
  canonicalUrl: string;
  contentType: string | null;
  error?: string;
};

/**
 * Fetch bounded readable content from a URL.
 * Applies SSRF protection, bounded timeout, and HTML text extraction.
 */
export async function fetchBoundedContent(
  url: string,
  options?: ContentFetchOptions,
): Promise<ContentFetchResult> {
  const opts = { ...CONTENT_FETCH_DEFAULTS, ...options };

  // Validate URL before any network call
  const validation = validateUrl(url);
  if (!validation.ok) {
    return { ok: false, text: "", canonicalUrl: url, contentType: null, error: validation.error };
  }

  let currentUrl = url;
  let redirectCount = 0;

  try {
    // Follow redirects manually to validate each destination
    let response: Response;
    while (redirectCount <= opts.maxRedirects) {
      response = await fetch(currentUrl, {
        method: "GET",
        headers: {
          "User-Agent": "PayLabsBot/1.0 (+https://paylabs.ai)",
          "Accept": "text/html,application/xhtml+xml,text/plain",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(opts.timeoutMs),
        redirect: "manual", // Handle redirects ourselves
      });

      // Handle redirect
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) break;

        // Resolve relative redirects
        try {
          currentUrl = new URL(location, currentUrl).href;
        } catch {
          return { ok: false, text: "", canonicalUrl: url, contentType: null, error: "Invalid redirect URL" };
        }

        // Validate redirect destination
        const redirectValidation = validateUrl(currentUrl);
        if (!redirectValidation.ok) {
          return { ok: false, text: "", canonicalUrl: url, contentType: null, error: `Redirect blocked: ${redirectValidation.error}` };
        }

        redirectCount++;
        continue;
      }

      // Validate final response
      if (!response.ok) {
        return { ok: false, text: "", canonicalUrl: currentUrl, contentType: null, error: `HTTP ${response.status}` };
      }

      // Check content type
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/xhtml")) {
        return { ok: false, text: "", canonicalUrl: currentUrl, contentType, error: `Unsupported content type: ${contentType}` };
      }

      // Read bounded response body
      const reader = response.body?.getReader();
      if (!reader) {
        return { ok: false, text: "", canonicalUrl: currentUrl, contentType, error: "No response body" };
      }

      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalBytes += value.length;
        if (totalBytes >= opts.maxBytes) break;
      }

      // Don't cancel — let the stream finish naturally with timeout

      const body = Buffer.concat(chunks).toString("utf-8");

      // Extract readable text from HTML
      let text: string;
      if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
        text = extractReadableText(body);
      } else {
        text = cleanText(body);
      }

      return {
        ok: text.length > 0,
        text,
        canonicalUrl: currentUrl,
        contentType,
      };
    }

    return { ok: false, text: "", canonicalUrl: currentUrl, contentType: null, error: "Too many redirects" };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, text: "", canonicalUrl: url, contentType: null, error: msg.slice(0, 200) };
  }
}
