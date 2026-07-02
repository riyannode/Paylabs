/**
 * RSSHub Route Catalog Loader
 *
 * Fetches and caches the full RSSHub route catalog from docs.rsshub.app/routes.json.
 * Flattens the nested namespace → routes structure into searchable records.
 * In-memory TTL cache with last-good fallback.
 *
 * No LLM. No secrets. No raw payload exposure.
 */

const DEFAULT_CATALOG_URL = "https://docs.rsshub.app/routes.json";
const DEFAULT_TTL_SECONDS = 21_600; // 6 hours

// ─── Types ──────────────────────────────────────────────────

export interface RsshubCatalogRoute {
  namespace: string;
  namespaceName: string;
  namespaceUrl: string;
  namespaceDescription: string;
  namespaceCategories: string[];
  namespaceHeat: number;
  routeKey: string;
  routePath: string;
  fullPath: string;
  name: string;
  description: string;
  categories: string[];
  example: string | null;
  parameters: Record<string, unknown>;
  features: Record<string, unknown> | null;
  radar: unknown[];
  topFeeds: unknown[];
  heat: number;
  docsUrl: string;
}

// ─── Cache ──────────────────────────────────────────────────

let cachedCatalog: RsshubCatalogRoute[] | null = null;
let cacheExpiresAt = 0;
let inflightFetch: Promise<RsshubCatalogRoute[]> | null = null;

// ─── Parser ─────────────────────────────────────────────────

/**
 * Parse the raw routes.json into flattened RsshubCatalogRoute[].
 * Defensive: handles missing fields, varying structures.
 */
function parseRoutesJson(raw: Record<string, unknown>): RsshubCatalogRoute[] {
  const results: RsshubCatalogRoute[] = [];

  for (const [namespace, nsData] of Object.entries(raw)) {
    if (!nsData || typeof nsData !== "object") continue;
    const ns = nsData as Record<string, unknown>;

    const namespaceName = String(ns.name || namespace);
    const namespaceUrl = String(ns.url || "");
    const namespaceDescription = String(ns.description || "");
    const namespaceCategories = Array.isArray(ns.categories)
      ? ns.categories.map(String)
      : [];
    const namespaceHeat = typeof ns.heat === "number" ? ns.heat : 0;

    const routes = ns.routes;
    if (!routes || typeof routes !== "object") continue;

    for (const [routeKey, routeData] of Object.entries(
      routes as Record<string, unknown>
    )) {
      if (!routeData || typeof routeData !== "object") continue;
      const rd = routeData as Record<string, unknown>;

      // Derive fullPath: routeKey already includes namespace prefix (e.g. "/npm/package/:name")
      // route.path is relative to namespace (e.g. "/package/:name")
      const routePath = String(rd.path || routeKey);
      const fullPath = routeKey.startsWith("/") ? routeKey : `/${namespace}${routeKey}`;

      const name = String(rd.name || "");
      const description = String(rd.description || "");
      const categories = Array.isArray(rd.categories)
        ? rd.categories.map(String)
        : namespaceCategories;
      const example =
        typeof rd.example === "string" ? rd.example : null;
      const parameters =
        rd.parameters && typeof rd.parameters === "object"
          ? (rd.parameters as Record<string, unknown>)
          : {};
      const features =
        rd.features && typeof rd.features === "object"
          ? (rd.features as Record<string, unknown>)
          : null;
      const radar = Array.isArray(rd.radar) ? rd.radar : [];
      const topFeeds = Array.isArray(rd.topFeeds) ? rd.topFeeds : [];
      const heat = typeof rd.heat === "number" ? rd.heat : namespaceHeat;

      const docsUrl = `https://docs.rsshub.app/routes#${encodeURIComponent(namespace)}`;

      results.push({
        namespace,
        namespaceName,
        namespaceUrl,
        namespaceDescription,
        namespaceCategories,
        namespaceHeat,
        routeKey,
        routePath,
        fullPath,
        name,
        description,
        categories,
        example,
        parameters,
        features,
        radar,
        topFeeds,
        heat,
        docsUrl,
      });
    }
  }

  return results;
}

// ─── Fetch ──────────────────────────────────────────────────

async function fetchCatalogFromRemote(
  catalogUrl: string
): Promise<RsshubCatalogRoute[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(catalogUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "PayLabs/0.1 RSSHub-Catalog" },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const raw = (await res.json()) as Record<string, unknown>;
    return parseRoutesJson(raw);
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Get the RSSHub route catalog. Uses in-memory TTL cache.
 * Falls back to last-good cache on fetch failure.
 *
 * @param opts.forceRefresh - bypass TTL and re-fetch
 */
export async function getRsshubCatalog(opts?: {
  forceRefresh?: boolean;
}): Promise<RsshubCatalogRoute[]> {
  const now = Date.now();
  const ttlMs =
    (Number(process.env.PAYLABS_RSSHUB_CATALOG_TTL_SECONDS) ||
      DEFAULT_TTL_SECONDS) * 1000;

  // Return cached if fresh
  if (!opts?.forceRefresh && cachedCatalog && now < cacheExpiresAt) {
    return cachedCatalog;
  }

  // Dedupe in-flight fetches
  if (inflightFetch) {
    return inflightFetch;
  }

  const catalogUrl =
    process.env.PAYLABS_RSSHUB_CATALOG_URL || DEFAULT_CATALOG_URL;

  inflightFetch = fetchCatalogFromRemote(catalogUrl)
    .then((routes) => {
      cachedCatalog = routes;
      cacheExpiresAt = now + ttlMs;
      return routes;
    })
    .catch((err: unknown) => {
      // Last-good fallback
      if (cachedCatalog) {
        console.warn("[rsshub-catalog] fetch failed, using cached", {
          error: err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100),
        });
        return cachedCatalog;
      }
      console.error("[rsshub-catalog] fetch failed, no cache", {
        error: err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100),
      });
      return [] as RsshubCatalogRoute[];
    })
    .finally(() => {
      inflightFetch = null;
    });

  return inflightFetch;
}
