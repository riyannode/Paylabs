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

/** Extract owner/repo pattern from goal string */
function extractOwnerRepo(goal: string): { owner: string; repo: string } | null {
  // Match "owner/repo" or "github.com/owner/repo"
  const patterns = [
    /github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)/i,
    /\b([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)\b/,
  ];
  for (const p of patterns) {
    const m = goal.match(p);
    if (m) {
      const owner = m[1].toLowerCase();
      const repo = m[2].toLowerCase().replace(/\.git$/, "");
      // Skip common false positives
      if (["http", "https", "www", "com", "org", "io"].includes(owner)) continue;
      if (repo.length < 2) continue;
      return { owner, repo };
    }
  }
  return null;
}

/** Check if a source matches the user's intent (entity in title/summary/url/route_path) */
function sourceMatchesIntent(s: SourceItem, ownerRepo: { owner: string; repo: string } | null): boolean {
  if (!ownerRepo) return true; // No entity to match against

  const { owner, repo } = ownerRepo;
  const title = (s.title || "").toLowerCase();
  const summary = (s.summary || "").toLowerCase();
  const url = (s.url || "").toLowerCase();
  const routePath = (s.route_path || "").toLowerCase();
  const domain = (s.domain || "").toLowerCase();

  // Check owner/repo in various fields
  const ownerRepoCombined = `${owner}/${repo}`;
  if (title.includes(ownerRepoCombined) || title.includes(repo)) return true;
  if (summary.includes(ownerRepoCombined) || summary.includes(repo)) return true;
  if (url.includes(ownerRepoCombined)) return true;
  if (routePath.includes(`/${owner}/${repo}`) || routePath.includes(`/${owner}`)) return true;
  if (domain.includes(owner)) return true;

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
    return "Tidak menemukan source yang cukup relevan untuk menjawab pertanyaan ini. Coba dengan query yang lebih spesifik atau topik berbeda.";
  }

  // Check entity intent match
  const ownerRepo = extractOwnerRepo(goal);
  const matchingSources = sourcesUsed.filter((s) => sourceMatchesIntent(s, ownerRepo));

  // If entity was specified but NO sources match it, treat as no-match
  if (ownerRepo && matchingSources.length === 0) {
    return `Tidak menemukan source yang relevan untuk ${ownerRepo.owner}/${ownerRepo.repo}. Source yang ditemukan tidak berkaitan dengan repository tersebut.`;
  }

  // Use matching sources (or all if no entity filter)
  const relevantSources = matchingSources.length > 0 ? matchingSources : sourcesUsed;
  const topSources = relevantSources.slice(0, maxSourcesInAnswer);
  const totalRelevant = relevantSources.length;

  // Build answer
  const parts: string[] = [];

  // Opening — context-aware
  if (ownerRepo) {
    parts.push(`Aktivitas terbaru yang ditemukan untuk ${ownerRepo.owner}/${ownerRepo.repo}:`);
  } else {
    // Generic opening based on goal keywords
    const goalLower = goal.toLowerCase();
    if (goalLower.includes("news") || goalLower.includes("latest") || goalLower.includes("update")) {
      parts.push(`Berikut ${totalRelevant} source terbaru yang ditemukan:`);
    } else if (goalLower.includes("research") || goalLower.includes("paper") || goalLower.includes("analysis")) {
      parts.push(`Ditemukan ${totalRelevant} source terkait riset/analisis:`);
    } else {
      parts.push(`Ditemukan ${totalRelevant} source relevan dari RSSHub:`);
    }
  }

  // Source bullets with real content
  for (let i = 0; i < topSources.length; i++) {
    parts.push(formatSourceBullet(topSources[i], i + 1));
  }

  // Confidence note if low
  if (sourceConfidence < 0.3) {
    parts.push("Catatan: relevansi sumber masih terbatas. Hasil bisa kurang akurat.");
  }

  return parts.join("\n");
}
