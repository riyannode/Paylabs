// Content ID service
// Generates deterministic content IDs from URLs

import { createHash } from "crypto";

export function generateContentId(url: string, siteId: string): string {
  const hash = createHash("sha256").update(`${siteId}:${url}`).digest("hex").slice(0, 16);
  return `${siteId}-${hash}`;
}

export function parseContentUrl(url: string): { host: string; path: string; searchParams: Record<string, string> } {
  const parsed = new URL(url);
  const searchParams: Record<string, string> = {};
  parsed.searchParams.forEach((value, key) => {
    searchParams[key] = value;
  });
  return {
    host: parsed.hostname,
    path: parsed.pathname,
    searchParams,
  };
}
