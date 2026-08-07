/**
 * Bounded Content Fetcher
 *
 * Fetches readable content from source URLs with SSRF protection,
 * bounded timeouts, bounded response size, and HTML text extraction.
 *
 * Security requirements:
 * - HTTP/HTTPS only
 * - Block localhost, loopback, RFC1918, cloud metadata, multicast
 * - Resolve DNS using dns.lookup with {all:true} and validate ALL addresses
 * - Re-validate on every redirect hop
 * - Fail closed on DNS resolution errors
 * - Bounded timeout, response bytes, redirects
 * - Validate content type
 * - No auth, no cookies, no JS execution
 */

import * as cheerio from "cheerio";
import dns from "node:dns/promises";
import type { ContentFetchOptions } from "./types";
import { CONTENT_FETCH_DEFAULTS } from "./types";

// ─── SSRF Protection ───────────────────────────────────────

/** Parse an IPv4 address string into a 32-bit integer */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    result = (result << 8) + n;
  }
  // Convert to unsigned 32-bit
  return result >>> 0;
}

/** Check if an IPv4 integer is in a blocked CIDR range (as integer + prefix length) */
function ipv4InCidr(ipInt: number, networkInt: number, prefixLen: number): boolean {
  const mask = (~0 << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (networkInt & mask);
}

/** Comprehensive check if an IP address string is in a blocked range */
function isPrivateOrBlockedIp(ip: string): boolean {
  // ── IPv4 ranges (check as integer for deterministic matching) ──
  const ipInt = ipv4ToInt(ip);
  if (ipInt !== null) {
    // 0.0.0.0/8
    if (ipv4InCidr(ipInt, ipv4ToInt("0.0.0.0")!, 8)) return true;
    // 10.0.0.0/8
    if (ipv4InCidr(ipInt, ipv4ToInt("10.0.0.0")!, 8)) return true;
    // 100.64.0.0/10
    if (ipv4InCidr(ipInt, ipv4ToInt("100.64.0.0")!, 10)) return true;
    // 127.0.0.0/8
    if (ipv4InCidr(ipInt, ipv4ToInt("127.0.0.0")!, 8)) return true;
    // 169.254.0.0/16 (link-local + cloud metadata)
    if (ipv4InCidr(ipInt, ipv4ToInt("169.254.0.0")!, 16)) return true;
    // 172.16.0.0/12
    if (ipv4InCidr(ipInt, ipv4ToInt("172.16.0.0")!, 12)) return true;
    // 192.168.0.0/16
    if (ipv4InCidr(ipInt, ipv4ToInt("192.168.0.0")!, 16)) return true;
    // 192.0.0.0/24 (IANA special)
    if (ipv4InCidr(ipInt, ipv4ToInt("192.0.0.0")!, 24)) return true;
    // 192.0.2.0/24 (documentation)
    if (ipv4InCidr(ipInt, ipv4ToInt("192.0.2.0")!, 24)) return true;
    // 198.51.100.0/24 (documentation)
    if (ipv4InCidr(ipInt, ipv4ToInt("198.51.100.0")!, 24)) return true;
    // 203.0.113.0/24 (documentation)
    if (ipv4InCidr(ipInt, ipv4ToInt("203.0.113.0")!, 24)) return true;
    // 224.0.0.0/4 (multicast)
    if (ipv4InCidr(ipInt, ipv4ToInt("224.0.0.0")!, 4)) return true;
    // 240.0.0.0/4 (reserved)
    if (ipv4InCidr(ipInt, ipv4ToInt("240.0.0.0")!, 4)) return true;
    return false;
  }

  // ── IPv6 ranges ──
  const ipLower = ip.toLowerCase();

  // Loopback
  if (ipLower === "::1" || ipLower === "::0" || ipLower === "::") return true;

  // IPv4-mapped: ::ffff:x.x.x.x — extract the embedded IPv4 and re-check
  const v4Mapped = ipLower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Mapped) return isPrivateOrBlockedIp(v4Mapped[1]);

  // IPv4-compatible: ::x.x.x.x (deprecated but block anyway)
  const v4Compat = ipLower.match(/^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Compat) return isPrivateOrBlockedIp(v4Compat[1]);

  // fc00::/7 (ULA)
  if (ipLower.startsWith("fc") || ipLower.startsWith("fd")) return true;

  // fe80::/10 (link-local)
  if (ipLower.startsWith("fe8") || ipLower.startsWith("fe9") ||
      ipLower.startsWith("fea") || ipLower.startsWith("feb")) return true;

  // 2001:db8::/32 (documentation)
  if (ipLower.startsWith("2001:db8")) return true;

  // All-zeros prefix (non-routable)
  if (/^0{1,4}(:0{1,4}){7}$/i.test(ipLower)) return true;

  return false;
}

/**
 * Resolve a hostname using dns.lookup with {all:true, verbatim:true}
 * and validate ALL returned addresses.
 *
 * Fail closed: any DNS error or ANY unsafe address → reject.
 * Uses verbatim:true to get literal DNS results without OS sorting.
 */
async function resolveAndValidateHost(hostname: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    for (const addr of addresses) {
      const ip = addr.address;
      if (isPrivateOrBlockedIp(ip)) {
        return { ok: false, error: `DNS resolved to blocked address: ${ip}` };
      }
    }
    return { ok: true };
  } catch {
    // Fail closed: DNS resolution error → do not proceed
    return { ok: false, error: `DNS resolution failed for ${hostname}` };
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

  // Block literal IPs directly
  const ipInt = ipv4ToInt(hostname);
  if (ipInt !== null) {
    if (isPrivateOrBlockedIp(hostname)) {
      return { ok: false, error: "Literal private IP blocked" };
    }
    return { ok: true }; // Public IP literal — no DNS needed
  }

  // Block localhost hostname
  if (hostname === "localhost") {
    return { ok: false, error: "Localhost blocked" };
  }

  // Block cloud metadata hostname
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
  const ipInt = ipv4ToInt(hostname);
  if (ipInt !== null) {
    return isPrivateOrBlockedIp(hostname)
      ? { ok: false, error: "Blocked literal IP" }
      : { ok: true };
  }

  // DNS validation for hostnames — fail closed
  return resolveAndValidateHost(hostname);
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
 * Applies SSRF protection with dns.lookup validation, bounded timeout, and HTML text extraction.
 * Fail closed: any DNS error blocks the request.
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

        // Re-validate redirect destination with full DNS check
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
