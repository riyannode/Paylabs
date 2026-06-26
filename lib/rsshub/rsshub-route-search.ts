/**
 * RSSHub Route Search
 *
 * Scores flattened RSSHub catalog routes against user intent.
 * Metadata-only — no network feed fetch. Returns top candidates.
 *
 * No LLM. No secrets. No raw payload exposure.
 */

import type { RsshubCatalogRoute } from "./rsshub-catalog";
import { getRsshubCatalog } from "./rsshub-catalog";

// ─── Types ──────────────────────────────────────────────────

export interface RsshubRouteCandidate {
  route: RsshubCatalogRoute;
  score: number;
  matchedTerms: string[];
  reason: string;
}

// ─── Scoring ────────────────────────────────────────────────

function normalizeLower(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * Score a single route against search terms.
 * Exact entity match > title/name match > description > category > heat.
 */
function scoreRoute(
  route: RsshubCatalogRoute,
  terms: string[],
  entityTerms: string[]
): { score: number; matchedTerms: string[]; reason: string } {
  let score = 0;
  const matched: string[] = [];
  const reasons: string[] = [];

  const routeName = normalizeLower(route.name);
  const routePath = normalizeLower(route.fullPath);
  const routeDesc = normalizeLower(route.description);
  const routeExample = route.example ? normalizeLower(route.example) : "";
  const routeNsUrl = normalizeLower(route.namespaceUrl);
  const routeCategories = route.categories.map(normalizeLower);

  // 1. Exact entity match (strongest signal)
  for (const entity of entityTerms) {
    const e = normalizeLower(entity);
    if (!e) continue;

    // Exact name match
    if (routeName === e || routeName.includes(e)) {
      score += 20;
      matched.push(entity);
      reasons.push(`name:${entity}`);
    }
    // Path contains entity
    else if (routePath.includes(e)) {
      score += 15;
      matched.push(entity);
      reasons.push(`path:${entity}`);
    }
    // Example contains entity (strong only if entity is specific)
    else if (routeExample.includes(e) && e.length > 3) {
      score += 12;
      matched.push(entity);
      reasons.push(`example:${entity}`);
    }
    // Namespace URL contains entity
    else if (routeNsUrl.includes(e)) {
      score += 10;
      matched.push(entity);
      reasons.push(`nsurl:${entity}`);
    }
    // Description contains entity
    else if (routeDesc.includes(e)) {
      score += 5;
      matched.push(entity);
      reasons.push(`desc:${entity}`);
    }
  }

  // 2. General term match (weaker)
  for (const term of terms) {
    const t = normalizeLower(term);
    if (!t || t.length < 3) continue;
    // Skip if already matched as entity
    if (matched.some((m) => normalizeLower(m).includes(t))) continue;

    if (routeName.includes(t)) {
      score += 8;
      matched.push(term);
      reasons.push(`name_term:${term}`);
    } else if (routePath.includes(t)) {
      score += 5;
      matched.push(term);
    } else if (routeDesc.includes(t)) {
      score += 2;
    }
  }

  // 3. Category match
  for (const term of [...entityTerms, ...terms]) {
    const t = normalizeLower(term);
    if (routeCategories.some((c) => c.includes(t) || t.includes(c))) {
      score += 3;
      reasons.push(`category:${term}`);
      break;
    }
  }

  // 3b. Boost /github/repo_event/ over /github/repos/ for owner/repo queries
  // Live validation: /github/repos/:user/:repo returns ALL user repos,
  // while /github/repo_event/:owner/:repo returns repo-specific activity.
  if (routePath.includes("/github/repo_event/")) {
    const hasOwnerRepoHint = entityTerms.some((e) => e.includes("/")) ||
      terms.some((t) => t.includes("/")) ||
      /\b(github|repo|repo_event|commit|issue|pr|pull)\b/i.test(
        entityTerms.join(" ") + " " + terms.join(" ")
      );
    if (hasOwnerRepoHint) {
      score += 6;
      reasons.push("repo_event_boost");
    }
  }

  // 4. Heat tie-breaker (ONLY if real match exists)
  const hasRealMatch = matched.length > 0 || reasons.some((r) =>
    r.startsWith("name") || r.startsWith("path") || r.startsWith("desc") ||
    r.startsWith("nsurl") || r.startsWith("example") || r.startsWith("category") ||
    r === "repo_event_boost"
  );
  if (hasRealMatch) {
    if (route.heat > 50) score += 2;
    else if (route.heat > 10) score += 1;
  }

  // 5. Has usable example (small boost, only if real match)
  if (route.example && hasRealMatch) score += 1;

  // 6. Dynamic params penalty if no entity resolved
  const hasDynamicParams = /:[a-zA-Z]/.test(route.routePath);
  if (hasDynamicParams && entityTerms.length === 0) {
    score -= 3;
    reasons.push("dynamic_no_entity");
  }

  // 7. If no real match at all, force score to 0
  //    Prevents heat/category-only noise from becoming candidates
  if (!hasRealMatch) {
    score = 0;
    reasons.length = 0;
  }

  return {
    score: Math.max(0, score),
    matchedTerms: [...new Set(matched)],
    reason: reasons.slice(0, 3).join(", ") || (score > 0 ? "weak_match" : "no_match"),
  };
}

// ─── Intent Detection ──────────────────────────────────────

interface RouteIntent {
  scope: "github_repo" | "github_user" | "general";
  owner?: string;
  repo?: string;
}

/**
 * Detect if the query is about a specific GitHub repo.
 * Patterns: "owner/repo", "github.com/owner/repo", "repo owner/repo"
 */
function detectRouteIntent(
  userGoal: string,
  entityTerms: string[]
): RouteIntent {
  const allText = [userGoal, ...entityTerms].join(" ");

  // Pattern 1: github.com/owner/repo
  const ghUrlMatch = allText.match(/github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)/i);
  if (ghUrlMatch) {
    const owner = ghUrlMatch[1].toLowerCase();
    const repo = ghUrlMatch[2].toLowerCase().replace(/\.git$/, "");
    if (!["www", "com", "org", "io"].includes(owner) && repo.length >= 2) {
      return { scope: "github_repo", owner, repo };
    }
  }

  // Pattern 2: owner/repo in entity terms (strong signal)
  for (const entity of entityTerms) {
    const m = entity.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
    if (m) {
      const owner = m[1].toLowerCase();
      const repo = m[2].toLowerCase().replace(/\.git$/, "");
      if (!["http", "https", "www", "com", "org", "io"].includes(owner) && repo.length >= 2) {
        return { scope: "github_repo", owner, repo };
      }
    }
  }

  // Pattern 3: GitHub user activity (no repo)
  if (/\bgithub\b/i.test(allText) && !/\bgithub\.com\//i.test(allText)) {
    // Check for user-level hints
    const userMatch = allText.match(/(?:github\s+(?:user|activity|profile)\s+(?:for\s+)?)?([a-zA-Z0-9_-]+)\b/i);
    if (userMatch && entityTerms.some((e) => e.toLowerCase() === userMatch[1].toLowerCase())) {
      return { scope: "github_user", owner: userMatch[1].toLowerCase() };
    }
  }

  return { scope: "general" };
}

/** Boost/filter routes based on detected intent */
function applyIntentFilter(
  candidates: Array<{ route: RsshubCatalogRoute; score: number; matchedTerms: string[]; reason: string }>,
  intent: RouteIntent
): Array<{ route: RsshubCatalogRoute; score: number; matchedTerms: string[]; reason: string }> {
  if (intent.scope === "general") return candidates;

  return candidates.map((c) => {
    const path = c.route.fullPath.toLowerCase();
    let boost = 0;
    let penalty = 0;

    if (intent.scope === "github_repo") {
      const owner = intent.owner || "";
      const repo = intent.repo || "";

      // Strong boost for repo-specific routes
      if (path.includes("/github/repo_event/") && path.includes(`/${owner}/${repo}`)) {
        boost += 20;
      } else if (path.includes("/github/repo_event/") && path.includes(`/${owner}`)) {
        boost += 15;
      } else if (path.match(/\/github\/(issue|pull|pulse|branches|contributors|discussion|file|stars|wiki)\//)) {
        // Other repo-specific GitHub routes
        boost += 10;
      } else if (path.includes("/github/activity/") || path.includes("/github/user_event/")) {
        // User activity — acceptable fallback for repo queries
        boost += 5;
      } else if (path.includes("/github/")) {
        // Other GitHub routes (search, trending, etc.) — less relevant
        penalty -= 3;
      }

      // Penalize non-GitHub routes heavily for repo queries
      if (!path.includes("/github/")) {
        penalty -= 15;
      }
    }

    if (intent.scope === "github_user") {
      if (path.includes("/github/activity/") || path.includes("/github/user_event/")) {
        boost += 15;
      } else if (path.includes("/github/")) {
        boost += 5;
      } else {
        penalty -= 10;
      }
    }

    return {
      ...c,
      score: Math.max(0, c.score + boost + penalty),
      reason: c.reason + (boost > 0 ? `,intent_boost:+${boost}` : "") + (penalty < 0 ? `,intent_penalty:${penalty}` : ""),
    };
  }).filter((c) => c.score > 0);
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Search RSSHub catalog routes against user intent.
 * Returns top candidates sorted by relevance score.
 *
 * @param input.userGoal - original user goal
 * @param input.expandedQueries - query variants from query_builder
 * @param input.entityTerms - exact entity terms
 * @param input.limit - max results (default 20)
 */
export async function searchRsshubRoutes(input: {
  userGoal: string;
  expandedQueries?: string[];
  entityTerms?: string[];
  limit?: number;
}): Promise<RsshubRouteCandidate[]> {
  const {
    userGoal,
    expandedQueries = [],
    entityTerms = [],
    limit = Number(process.env.PAYLABS_RSSHUB_ROUTE_SEARCH_LIMIT) || 20,
  } = input;

  const catalog = await getRsshubCatalog();
  if (catalog.length === 0) return [];

  // Build search terms: entity terms + expanded query words
  const allTerms: string[] = [];
  for (const q of expandedQueries) {
    allTerms.push(...q.split(/\s+/).filter((w) => w.length > 2));
  }
  // Also add userGoal words
  allTerms.push(...userGoal.split(/\s+/).filter((w) => w.length > 2));

  const uniqueTerms = [...new Set(allTerms)];
  const uniqueEntities = [...new Set(entityTerms)];

  // Score all routes
  const scored: RsshubRouteCandidate[] = [];
  for (const route of catalog) {
    const result = scoreRoute(route, uniqueTerms, uniqueEntities);
    if (result.score > 0) {
      scored.push({
        route,
        score: result.score,
        matchedTerms: result.matchedTerms,
        reason: result.reason,
      });
    }
  }

  // Sort by score descending, heat as tie-breaker
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.route.heat - a.route.heat;
  });

  // Apply intent filter (GitHub repo scoping, etc.)
  const intent = detectRouteIntent(userGoal, uniqueEntities);
  const filtered = applyIntentFilter(scored, intent);

  return filtered.slice(0, limit);
}
