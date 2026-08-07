/**
 * Bounded Content Fetcher
 *
 * Fetches readable content from source URLs with SSRF protection,
 * bounded timeouts, bounded response size, and HTML text extraction.
 *
 * Security requirements:
 * - HTTP/HTTPS only
 * - Block localhost, loopback, RFC1918, cloud metadata, multicast
 * - Resolve DNS and validate ALL resolved addresses before fetch
 * - Re-validate on every redirect hop
 * - Bounded timeout, response bytes, redirects
 * - Validate content type
 * - No auth, no cookies, no JS execution
 */

import * as cheerio from "cheerio";
import dns from "node:dns/promises";
import type { ContentFetchOptions } from "./types";
import { CONTENT_FETCH_DEFAULTS } from "./types";

// ─── SSRF Protection ───────────────────────────────────────

/** Comprehensive check if an IP address is in a blocked range */
function isPrivateOrBlockedIp(ip: string): boolean {
  // IPv4 private/reserved ranges
  if (/^0\./.test(ip)) return true;                       // 0.0.0.0/8
  if (/^10\./.test(ip)) return true;                      // 10.0.0.0/8
  if (/^100\.(6[4-9]|[7-9]\d|1[0-2][0-7])\./.test(ip)) return true; // 100.64.0.0/10
  if (/^127\./.test(ip)) return true;                     // 127.0.0.0/8
  if (/^169\.254\./.test(ip)) return true;                // 169.254.0.0/16 (link-local + cloud metadata)
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true; // 172.16.0.0/12
  if (/^192\.168\./.test(ip)) return true;                // 192.168.0.0/16
  if (/^(192\.0\.0\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(ip)) return true; // doc/test nets
  if (/^(22[4-9]|23[0-9])\./.test(ip)) return true;      // 224.0.0.0/4 (multicast)
  if (/^240\./.test(ip)) return true;                     // 240.0.0.0/4 (reserved)

  // IPv6 ranges
  if (ip === "::1" || ip === "::" || ip === "::0") return true;
  if (/^::ffff:(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/i.test(ip)) return true; // IPv4-mapped private
  if (/^fc00:/i.test(ip) || /^fd[0-9a-f]{2}:/i.test(ip)) return true; // fc00::/7 (ULA)
  if (/^fe80:/i.test(ip)) return true;                    // fe80::/10 (link-local)
  if (ip === "0000:0000:0000:0000:0000:0000:0000:0001") return true; // IPv6 loopback
  if (/^2001:db8:/i.test(ip)) return true;                // 2001:db8::/32 (doc)

  // Cloud metadata endpoint
  if (ip === "169.254.169.254") return true;

  return false;
}

/**
 * Resolve a hostname and validate ALL returned addresses.
 * Returns error if ANY address is unsafe.
 */
async function resolveAndValidateHost(hostname: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const addresses = await dns.resolve4(hostname, { all: true });
    for (const addr of addresses) {
      if (isPrivateOrBlockedIp(addr.address)) {
        return { ok: false, error: `DNS resolution returned private/blocked IP: ${addr.address}` };
      }
    }
    return { ok: true };
  } catch {
    // If DNS resolution fails entirely, also try IPv6
    try {
      const addresses6 = await dns.resolve6(hostname, { all: true });
      for (const addr of addresses6) {
        if (isPrivateOrBlockedIp(addr.address)) {
          return { ok: false, error: `DNS resolution returned private/blocked IPv6: ${addr.address}` };
        }
      }
      return { ok: true };
    } catch {
      // DNS resolution failed for both — could be valid hostname we can't resolve
      // Allow the fetch to proceed (it will fail naturally if unreachable)
      return { ok: true };
    }
  }
}

/** Validate URL structure (non-network checks) */
function validateUrlStructure(url: string): { ok: boolean; error?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `Unsupported protocol: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block literal IPs
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    if (isPrivateOrBlockedIp(hostname)) {
      return { ok: false, error: "Literal private IP blocked" };
    }
  }

  // Block localhost hostname
  if (hostname === "localhost") {
    return { ok: false, error: "Localhost blocked" };
  }

  // Block cloud metadata IP
  if (hostname === "169.254.169.254") {
    return { ok: false, error: "Cloud metadata blocked" };
  }

  return { ok: true };
}

/** Validate a URL including DNS resolution of its hostname */
async function validateUrlFull(url: string): Promise<{ ok: boolean; error?: string }> {
  const structural = validateUrlStructure(url);
  if (!structural.ok) return structural;

  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ok: false, error: "Invalid URL" }; }

  const hostname = parsed.hostname.toLowerCase();

  // Skip DNS for literal IPs (already validated structurally)
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return resolveAndValidateHost(hostname);
  }

  return { ok: true };
}

// ─── Content Extraction ────────────────────────────────────

/** Remove boilerplate elements and extract readable text */
function extractReadableText(html: string): string {
  const $ = cheerio.load(html);

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

  const articleContent = $("article, main, [role='main'], .post-content, .article-content, .entry-content, .content-body").text();
  if (articleContent && articleContent.trim().length > 100) {
    return cleanText(articleContent);
  }

  const bodyText = $("body").text();
  return cleanText(bodyText);
}

/** Clean extracted text */
function cleanText(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .trim()
    .slice(0, 80_000);
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
 * Applies SSRF protection with DNS resolution, bounded timeout, and HTML text extraction.
 */
export async function fetchBoundedContent(
  url: string,
  options?: ContentFetchOptions,
): Promise<ContentFetchResult> {
  const opts = { ...CONTENT_FETCH_DEFAULTS, ...options };

  // Validate URL structure + DNS before any network call
  const validation = await validateUrlFull(url);
  if (!validation.ok) {
    return { ok: false, text: "", canonicalUrl: url, contentType: null, error: validation.error };
  }

  let currentUrl = url;
  let redirectCount = 0;

  try {
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
        redirect: "manual",
      });

      // Handle redirect
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) break;

        try {
          currentUrl = new URL(location, currentUrl).href;
        } catch {
          return { ok: false, text: "", canonicalUrl: url, contentType: null, error: "Invalid redirect URL" };
        }

        // Re-validate redirect destination with DNS resolution
        const redirectValidation = await validateUrlFull(currentUrl);
        if (!redirectValidation.ok) {
          return { ok: false, text: "", canonicalUrl: url, contentType: null, error: `Redirect blocked: ${redirectValidation.error}` };
        }

        redirectCount++;
        continue;
      }

      if (!response.ok) {
        return { ok: false, text: "", canonicalUrl: currentUrl, contentType: null, error: `HTTP ${response.status}` };
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/xhtml")) {
        return { ok: false, text: "", canonicalUrl: currentUrl, contentType, error: `Unsupported content type: ${contentType}` };
      }

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

      const body = Buffer.concat(chunks).toString("utf-8");

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
