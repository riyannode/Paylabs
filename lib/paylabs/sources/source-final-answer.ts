/**
 * Source-Grounded Final Answer Builder
 *
 * Generates a concise user-facing answer from source_context.
 * Deterministic for Easy tier — no LLM.
 *
 * Rules:
 * - Use safe fields: title, summary, domain, published_at, url, route_path.
 * - If sources exist: answer WHAT was found with titles + summaries.
 * - If sources don't match the user's entity/intent: return no-match answer.
 * - No raw CoT. No raw RSS payload. No fabricated facts.
 */

import type { SourceItem } from "./types";

// ─── Types ──────────────────────────────────────────────────

export interface FinalAnswerInput {
  goal: string;
  sourcesUsed: SourceItem[];
  sourceConfidence: number;
  retrievalMode?: string;
  maxSourcesInAnswer?: number;
}

// ─── Helpers ────────────────────────────────────────────────

/** Extract owner/repo pattern from goal string — only for real GitHub intents */
function extractOwnerRepo(goal: string): { owner: string; repo: string } | null {
  const goalLower = goal.toLowerCase();

  // Pattern 1: github.com/owner/repo (always valid)
  const ghUrl = goal.match(/github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)/i);
  if (ghUrl) {
    const owner = ghUrl[1].toLowerCase();
    const repo = ghUrl[2].toLowerCase().replace(/\.git$/, "");
    if (!["www", "com", "org", "io"].includes(owner) && repo.length >= 2) {
      return { owner, repo };
    }
  }

  // Pattern 2: owner/repo — only if goal has GitHub/repo context
  const hasGithubIntent =
    /\bgithub\b/i.test(goal) ||
    /\brepo\b/i.test(goal) ||
    /\brepository\b/i.test(goal) ||
    /\bcommit\b/i.test(goal) ||
    /\bpull request\b/i.test(goal) ||
    /\bpr\b/i.test(goal);

  if (!hasGithubIntent) return null;

  const slash = goal.match(/\b([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)\b/);
  if (!slash) return null;

  const owner = slash[1].toLowerCase();
  const repo = slash[2].toLowerCase().replace(/\.git$/, "");

  if (["http", "https", "www", "com", "org", "io", "api", "v1", "v2"].includes(owner)) return null;
  if (repo.length < 2) return null;

  return { owner, repo };
}

/** Check if a source matches the user's intent — require repo match, not just owner */
function sourceMatchesIntent(s: SourceItem, ownerRepo: { owner: string; repo: string } | null): boolean {
  if (!ownerRepo) return true; // No entity to match against

  const { owner, repo } = ownerRepo;
  const title = (s.title || "").toLowerCase();
  const summary = (s.summary || "").toLowerCase();
  const url = (s.url || "").toLowerCase();
  const routePath = (s.route_path || "").toLowerCase();

  const ownerRepoCombined = `${owner}/${repo}`;

  // URL contains owner/repo (strongest)
  if (url.includes(ownerRepoCombined)) return true;
  // route_path contains /owner/repo
  if (routePath.includes(`/${owner}/${repo}`)) return true;
  // title or summary contains owner/repo or repo name
  if (title.includes(ownerRepoCombined) || title.includes(repo)) return true;
  if (summary.includes(ownerRepoCombined) || summary.includes(repo)) return true;

  return false;
}

/** Format a single source as a concise bullet */
function formatSourceBullet(s: SourceItem, index: number): string {
  const title = s.title || "(untitled)";
  const domain = s.domain ? ` (${s.domain})` : "";
  const published = s.published_at
    ? new Date(s.published_at).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })
    : "";
  const dateStr = published ? `, ${published}` : "";

  // Include brief summary excerpt if available
  const summaryExcerpt = s.summary
    ? s.summary.replace(/\n+/g, " ").slice(0, 120).trim()
    : "";
  const summarySuffix = summaryExcerpt ? ` — ${summaryExcerpt}${summaryExcerpt.length >= 120 ? "..." : ""}` : "";

  return `[${index}] ${title}${domain}${dateStr}${summarySuffix}`;
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Build a deterministic source-grounded final answer.
 * Easy tier: deterministic template with real source content.
 * Normal/Advanced: same template (LLM re-ranking happens elsewhere).
 */
export function buildSourceGroundedFinalAnswer(
  input: FinalAnswerInput
): string {
  const {
    goal,
    sourcesUsed,
    sourceConfidence,
    retrievalMode,
    maxSourcesInAnswer = 5,
  } = input;

  // No sources found
  if (!sourcesUsed || sourcesUsed.length === 0) {
    return "No sufficiently relevant sources found for this query. Try a more specific query or a different topic.";
  }

  // Check entity intent match
  const ownerRepo = extractOwnerRepo(goal);
  const matchingSources = sourcesUsed.filter((s) => sourceMatchesIntent(s, ownerRepo));

  // If entity was specified but NO sources match it, treat as no-match
  if (ownerRepo && matchingSources.length === 0) {
    return `No relevant sources found for ${ownerRepo.owner}/${ownerRepo.repo}. The sources found are not related to this repository.`;
  }

  // Use matching sources (or all if no entity filter)
  const relevantSources = matchingSources.length > 0 ? matchingSources : sourcesUsed;
  const topSources = relevantSources.slice(0, maxSourcesInAnswer);
  const totalRelevant = relevantSources.length;

  // Build answer
  const parts: string[] = [];

  // Opening — context-aware
  if (ownerRepo) {
    parts.push(`Latest activity found for ${ownerRepo.owner}/${ownerRepo.repo}:`);
  } else {
    // Generic opening based on goal keywords
    const goalLower = goal.toLowerCase();
    if (goalLower.includes("news") || goalLower.includes("latest") || goalLower.includes("update")) {
      parts.push(`Here are ${totalRelevant} latest sources found:`);
    } else if (goalLower.includes("research") || goalLower.includes("paper") || goalLower.includes("analysis")) {
      parts.push(`Found ${totalRelevant} sources related to research/analysis:`);
    } else {
      parts.push(`Found ${totalRelevant} relevant sources from RSSHub:`);
    }
  }

  // Source bullets with real content
  for (let i = 0; i < topSources.length; i++) {
    parts.push(formatSourceBullet(topSources[i], i + 1));
  }

  // Confidence note if low
  if (sourceConfidence < 0.3) {
    parts.push("Note: source relevance is limited. Results may be less accurate.");
  }

  return parts.join("\n");
}
