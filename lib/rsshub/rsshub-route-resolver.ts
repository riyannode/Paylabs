/**
 * RSSHub Route Resolver
 *
 * Turns route candidates into concrete fetchable RSSHub feed paths.
 * Resolves dynamic :param segments from user query/entity terms.
 * Conservative: skips routes when params cannot be resolved.
 *
 * No LLM. No secrets. No raw payload exposure.
 */

import type { RsshubRouteCandidate } from "./rsshub-route-search";

// ─── Types ──────────────────────────────────────────────────

export interface ResolvedRsshubRoute {
  route: RsshubRouteCandidate["route"];
  resolvedPath: string;
  rsshubFeedUrl: string;
  docsUrl: string;
  resolveMode: "exact_param" | "example_direct" | "static";
  confidence: number;
  safeReason: string;
}

// ─── Param Extraction ───────────────────────────────────────

/**
 * Extract :param names from a route path.
 * E.g. "/npm/package/:name{(@[a-z0-9-~]...)?}" → ["name"]
 */
function extractParamNames(routePath: string): string[] {
  const params: string[] = [];
  const regex = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let match;
  while ((match = regex.exec(routePath)) !== null) {
    params.push(match[1]);
  }
  return params;
}

/**
 * Check if a route path has dynamic parameters.
 */
function hasDynamicParams(routePath: string): boolean {
  return /:[a-zA-Z]/.test(routePath);
}

/**
 * Strip regex body from param: ":name{regex}" → ":name"
 * Used for replacement.
 */
function stripParamRegex(paramSegment: string): string {
  return paramSegment.replace(/\{[^}]*\}/g, "");
}

// ─── Entity Value Extraction ────────────────────────────────

/**
 * Generic stop words that should not be used as route parameter values.
 */
const STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "are", "was",
  "were", "been", "have", "has", "had", "not", "but", "can", "will",
  "latest", "update", "updates", "new", "news", "source", "article",
  "articles", "about", "what", "how", "find", "search", "discover",
  "show", "get", "fetch", "compare", "vs", "versus",
]);

/**
 * Extract npm package name from terms.
 * Handles scoped packages: @scope/name
 */
function extractNpmPackage(terms: string[], query: string): string | null {
  // Check query for @scope/name pattern
  const scopedMatch = query.match(/@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*/i);
  if (scopedMatch) return scopedMatch[0];

  // Check terms for npm-likely names (after "npm" keyword)
  const queryLower = query.toLowerCase();
  const npmIndex = queryLower.indexOf("npm");
  if (npmIndex >= 0) {
    // Look for package name after "npm"
    const afterNpm = query.slice(npmIndex + 3).trim();
    const words = afterNpm.split(/\s+/).filter((w) => w.length > 1);
    for (const w of words) {
      if (!STOP_WORDS.has(w.toLowerCase()) && !/^(package|install|update|latest|new|the)$/i.test(w)) {
        return w;
      }
    }
  }

  // Check terms for entity that looks like a package name
  for (const term of terms) {
    if (term.startsWith("@")) return term;
    if (
      term.length > 2 &&
      !STOP_WORDS.has(term.toLowerCase()) &&
      /^[a-z0-9@][a-z0-9._-]*$/i.test(term)
    ) {
      return term;
    }
  }

  return null;
}

/**
 * Extract GitHub owner/repo from terms.
 */
function extractGithubOwnerRepo(
  terms: string[],
  query: string
): { owner: string; repo: string } | null {
  // 1. Parse explicit github.com URL first (most reliable)
  const githubUrlMatch = query.match(/https?:\/\/github\.com\/([^/\s?#]+)\/([^/\s?#]+)/i);
  if (githubUrlMatch) {
    const owner = githubUrlMatch[1];
    const repo = githubUrlMatch[2].replace(/\.git$/, "");
    if (owner.length > 1 && repo.length > 1) {
      return { owner, repo };
    }
  }

  // 2. Check query for owner/repo pattern (with dot rejection on owner)
  const match = query.match(
    /([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)/
  );
  if (match) {
    const owner = match[1];
    const repo = match[2];
    // Validate: not a URL path, not a file path, owner has no dots
    if (
      !owner.startsWith("http") &&
      !owner.includes(".") && // reject github.com, www.github.com etc
      !repo.includes(".") &&
      owner.length > 1 &&
      repo.length > 1
    ) {
      return { owner, repo };
    }
  }

  // 3. Check if two consecutive entity terms look like owner/repo
  for (let i = 0; i < terms.length - 1; i++) {
    const a = terms[i];
    const b = terms[i + 1];
    if (
      a.length > 1 &&
      b.length > 1 &&
      !STOP_WORDS.has(a.toLowerCase()) &&
      !STOP_WORDS.has(b.toLowerCase()) &&
      !a.includes(".") && // reject domain-like terms
      !b.includes(".") &&
      /^[a-zA-Z0-9._-]+$/.test(a) &&
      /^[a-zA-Z0-9._-]+$/.test(b)
    ) {
      return { owner: a, repo: b };
    }
  }

  return null;
}

/**
 * Extract a URL from the query string.
 */
function extractUrl(query: string): string | null {
  const match = query.match(/https?:\/\/[^\s]+/);
  return match ? match[0] : null;
}

// ─── Route Resolution ───────────────────────────────────────

/**
 * Resolve a single route candidate into a concrete feed path.
 * Returns null if params cannot be resolved.
 */
function resolveSingleRoute(
  candidate: RsshubRouteCandidate,
  query: string,
  entityTerms: string[],
  baseUrl: string
): ResolvedRsshubRoute | null {
  const route = candidate.route;
  const routePath = route.routePath;
  const fullPath = route.fullPath;

  // 1. Static route — no params
  if (!hasDynamicParams(routePath)) {
    return {
      route,
      resolvedPath: fullPath,
      rsshubFeedUrl: `${baseUrl.replace(/\/+$/, "")}${fullPath}`,
      docsUrl: route.docsUrl,
      resolveMode: "static",
      confidence: 0.9,
      safeReason: "static route",
    };
  }

  // 2. Dynamic route — need param resolution
  const params = extractParamNames(routePath);
  if (params.length === 0) {
    // Shouldn't happen but defensive
    return {
      route,
      resolvedPath: fullPath,
      rsshubFeedUrl: `${baseUrl.replace(/\/+$/, "")}${fullPath}`,
      docsUrl: route.docsUrl,
      resolveMode: "static",
      confidence: 0.8,
      safeReason: "no params detected",
    };
  }

  // Try to resolve params based on route type
  const allTerms = [...entityTerms, ...query.split(/\s+/)];
  const queryLower = query.toLowerCase();

  // npm package route
  if (
    route.namespace === "npm" ||
    fullPath.includes("/npm/") ||
    routePath.includes(":name")
  ) {
    const pkg = extractNpmPackage(entityTerms, query);
    if (pkg) {
      let resolved = fullPath;
      // For scoped packages (@scope/name), preserve @ and / in path
      // For regular packages, encode normally
      const encodedPkg = pkg.startsWith("@")
        ? pkg  // @langchain/core stays as-is (RSSHub expects literal @scope/name in path)
        : encodeURIComponent(pkg);
      // Replace :name{regex} or :name with the package
      resolved = resolved.replace(
        /:name(\{[^}]*\})?/,
        encodedPkg
      );
      // Replace other params if any
      for (const p of params) {
        if (p !== "name") {
          const placeholder = new RegExp(`:${p}(\\{[^}]*\\})?`);
          if (placeholder.test(resolved)) {
            // Cannot resolve other params, skip
            return null;
          }
        }
      }
      return {
        route,
        resolvedPath: resolved,
        rsshubFeedUrl: `${baseUrl.replace(/\/+$/, "")}${resolved}`,
        docsUrl: route.docsUrl,
        resolveMode: "exact_param",
        confidence: 0.95,
        safeReason: `npm package: ${pkg}`,
      };
    }
  }

  // GitHub owner/repo route
  if (
    route.namespace === "github" ||
    fullPath.includes("/github/") ||
    (params.includes("owner") && params.includes("repo")) ||
    (params.includes("user") && params.includes("repo"))
  ) {
    const gh = extractGithubOwnerRepo(entityTerms, query);
    if (gh) {
      let resolved = fullPath;
      // Replace :owner OR :user with the extracted owner
      resolved = resolved.replace(
        /:owner(\{[^}]*\})?/,
        encodeURIComponent(gh.owner)
      );
      resolved = resolved.replace(
        /:user(\{[^}]*\})?/,
        encodeURIComponent(gh.owner)
      );
      resolved = resolved.replace(
        /:repo(\{[^}]*\})?/,
        encodeURIComponent(gh.repo)
      );
      // Check for unresolved params — do NOT fill from docs examples
      // (Finding 2: docs examples may be unrelated to the user's query)
      const remaining = extractParamNames(resolved);
      if (remaining.length > 0) {
        // Cannot resolve all params from actual query — skip this route
        return null;
      }
      return {
        route,
        resolvedPath: resolved,
        rsshubFeedUrl: `${baseUrl.replace(/\/+$/, "")}${resolved}`,
        docsUrl: route.docsUrl,
        resolveMode: "exact_param",
        confidence: 0.9,
        safeReason: `github: ${gh.owner}/${gh.repo}`,
      };
    }
  }

  // Generic param resolution from entity terms
  // Try to fill params from entity terms in order
  // Exclude internal planner constraint tags and entities not in original query
  const INTERNAL_ENTITY_TAGS = new Set([
    "recency_priority", "trust_required", "source_required",
    "citation_required", "freshness_required", "payment_required",
    "budget_required", "quality_priority", "free_only",
  ]);
  const filteredEntities = entityTerms.filter((e) => {
    const lower = e.toLowerCase().trim();
    return (
      !INTERNAL_ENTITY_TAGS.has(lower) &&
      !STOP_WORDS.has(lower) &&
      e.length > 1 &&
      queryLower.includes(lower) // must appear in original query
    );
  });

  if (filteredEntities.length >= params.length) {
    let resolved = fullPath;
    for (let i = 0; i < params.length; i++) {
      const param = params[i];
      const value = filteredEntities[i];
      const regex = new RegExp(`:${param}(\\{[^}]*\\})?`);
      resolved = resolved.replace(regex, encodeURIComponent(value));
    }
    // Verify all params resolved
    if (!hasDynamicParams(resolved)) {
      return {
        route,
        resolvedPath: resolved,
        rsshubFeedUrl: `${baseUrl.replace(/\/+$/, "")}${resolved}`,
        docsUrl: route.docsUrl,
        resolveMode: "exact_param",
        confidence: 0.7,
        safeReason: `generic param fill from entities`,
      };
    }
  }

  // Last resort: use example ONLY if example param value matches an actual requested entity
  // (Finding 2: namespace/path terms alone are NOT enough — the example entity must match user query)
  if (route.example && entityTerms.length > 0) {
    const exampleParts = route.example.split("/").filter(Boolean);
    // Extract the param values from the example path (the parts that would fill :param slots)
    const paramNames = extractParamNames(routePath);
    const exampleParamValues: string[] = [];
    for (let i = 0; i < paramNames.length; i++) {
      // Find the example part that corresponds to this param
      // Simple heuristic: param values are the non-namespace parts of the example path
      const part = exampleParts[i + 1]; // +1 to skip namespace
      if (part) exampleParamValues.push(part.toLowerCase());
    }
    // Check if any example param value matches an actual entity term from the user's query
    const entityTermsLower = entityTerms.map((e) => e.toLowerCase().trim());
    const exampleMatchesEntity = exampleParamValues.some((ev) =>
      entityTermsLower.some((et) => et === ev || et.includes(ev) || ev.includes(et))
    );
    if (exampleMatchesEntity) {
      return {
        route,
        resolvedPath: route.example,
        rsshubFeedUrl: `${baseUrl.replace(/\/+$/, "")}${route.example}`,
        docsUrl: route.docsUrl,
        resolveMode: "example_direct",
        confidence: 0.6,
        safeReason: `example (entity match)`,
      };
    }
  }

  // Cannot resolve — skip
  return null;
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Resolve route candidates into concrete fetchable RSSHub paths.
 * Conservative: skips when params cannot be resolved.
 *
 * @param input.candidates - from searchRsshubRoutes
 * @param input.query - original user query
 * @param input.entityTerms - exact entity terms
 * @param input.baseUrl - RSSHub base URL
 * @param input.limit - max resolved routes (default from env)
 */
export async function resolveRsshubRoutes(input: {
  candidates: RsshubRouteCandidate[];
  query: string;
  entityTerms?: string[];
  baseUrl: string;
  limit?: number;
}): Promise<ResolvedRsshubRoute[]> {
  const {
    candidates,
    query,
    entityTerms = [],
    baseUrl,
    limit = Number(process.env.PAYLABS_RSSHUB_LIVE_MAX_ROUTES) || 10,
  } = input;

  const resolved: ResolvedRsshubRoute[] = [];

  for (const candidate of candidates) {
    if (resolved.length >= limit) break;

    const result = resolveSingleRoute(candidate, query, entityTerms, baseUrl);
    if (result) {
      // Dedupe by resolvedPath
      if (!resolved.some((r) => r.resolvedPath === result.resolvedPath)) {
        resolved.push(result);
      }
    }
  }

  return resolved;
}
