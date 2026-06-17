// Site validation service
// Validates content URLs against supported sites

import { config } from "../config.js";

export interface SiteInfo {
  id: string;
  name: string;
  hosts: string[];
  publishTarget: boolean;
}

const SITE_MAP: Record<string, SiteInfo> = {
  "arc-community": {
    id: "arc-community",
    name: "Arc Community",
    hosts: ["community.arc.io", "community.arc.network"],
    publishTarget: true,
  },
  sepiasearch: {
    id: "sepiasearch",
    name: "SepiaSearch",
    hosts: ["sepiasearch.org"],
    publishTarget: false,
  },
};

const PEERTUBE_PATH_PATTERNS = [/^\/w\//, /^\/videos\/watch\//, /^\/videos\/embed\//];

export function validateSite(url: string): { valid: boolean; siteId?: string; error?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: "Invalid URL" };
  }

  const host = parsed.hostname;
  if (!config.allowedHosts.includes(host)) {
    return { valid: false, error: `Host ${host} is not supported` };
  }

  // Find matching site
  for (const [siteId, site] of Object.entries(SITE_MAP)) {
    if (site.hosts.includes(host)) {
      // SepiaSearch: target URL must look like a PeerTube video
      if (siteId === "sepiasearch") {
        const targetUrl = parsed.searchParams.get("url") ?? parsed.searchParams.get("target");
        if (targetUrl) {
          try {
            const target = new URL(targetUrl);
            if (target.protocol !== "https:") {
              return { valid: false, error: "SepiaSearch target must use HTTPS" };
            }
            const isPeerTube = PEERTUBE_PATH_PATTERNS.some((p) => p.test(target.pathname));
            if (!isPeerTube) {
              return { valid: false, error: "SepiaSearch target must be a PeerTube video URL" };
            }
          } catch {
            return { valid: false, error: "Invalid target URL in SepiaSearch link" };
          }
        }
      }
      return { valid: true, siteId };
    }
  }

  return { valid: false, error: "No matching site found" };
}

export function getSiteById(siteId: string): SiteInfo | null {
  return SITE_MAP[siteId] ?? null;
}

export function getAllSites(): SiteInfo[] {
  return Object.values(SITE_MAP);
}
