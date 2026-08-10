import { getEntityEvidenceAliases, getProtocolEvidenceAliases } from "./crypto-entity-registry";
import {
  matchesRequestedAspect,
  normalizeAspectConstraints,
  type RequestedAspectConstraint,
} from "./query-requirements";

export type StructuredEntity = {
  text: string;
  canonical: string;
  type: string;
  required: boolean;
};

export type RelevanceCandidate = {
  title?: string;
  summary?: string;
  domain?: string | null;
  source_url?: string;
  route_path?: string | null;
  author?: string;
  publisher?: string;
  relevance_score?: number;
};

export type RelevanceResult = {
  accepted: boolean;
  score: number;
  matchedPrimaryEntities: string[];
  matchedSecondaryEntities: string[];
  matchedLockedPhrases: string[];
  matchedNegativeEntities: string[];
  rejectionReason?: "missing_required_entity" | "topic_only_match" | "generic_token_only" | "negative_entity_match" | "zero_or_negative_score" | "invalid_url" | "intent_mismatch" | "missing_requested_aspect" | "duplicate_canonical_url";
};

export function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeEntity(value: string): string {
  return normalizeSearchText(value);
}

export function matchesExactPhrase(text: string, phrase: string): boolean {
  const haystack = ` ${normalizeSearchText(text)} `;
  const needle = ` ${normalizeSearchText(phrase)} `;
  return !!needle.trim() && haystack.includes(needle);
}

export function matchesControlledAlias(text: string, entity: StructuredEntity): boolean {
  const aliases = getEntityEvidenceAliases(entity.canonical);
  return [entity.canonical, entity.text, ...aliases].some((alias) => matchesExactPhrase(text, alias));
}

function closeTokenMatch(text: string, entity: string): boolean {
  const haystack = normalizeSearchText(text).split(" ");
  const tokens = normalizeEntity(entity).split(" ").filter(Boolean);
  if (!tokens.length) return false;
  if (tokens.length === 1) return haystack.includes(tokens[0]);
  for (let i = 0; i <= haystack.length - tokens.length; i += 1) {
    if (tokens.every((token, offset) => haystack[i + offset] === token)) return true;
  }
  return false;
}

export function matchesRequiredEntity(text: string, entity: StructuredEntity): boolean {
  const protocolEvidenceAliases = getProtocolEvidenceAliases(entity.canonical);
  if (protocolEvidenceAliases.length > 0) {
    return protocolEvidenceAliases.some((alias) => matchesExactPhrase(text, alias)) || matchesControlledAlias(text, entity);
  }
  return matchesControlledAlias(text, entity) || closeTokenMatch(text, entity.canonical);
}

function searchableUrlMetadata(value?: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    return `${url.hostname} ${url.pathname}`;
  } catch {
    return value;
  }
}

export function scoreCandidateRelevance(
  candidate: RelevanceCandidate,
  context: {
    primaryEntities?: StructuredEntity[];
    secondaryEntities?: StructuredEntity[];
    lockedPhrases?: string[];
    negativeEntities?: string[];
    entityTerms?: string[];
    topics?: string[];
    intentType?: string;
  }
): RelevanceResult {
  const title = candidate.title || "";
  const summary = candidate.summary || "";
  const metadata = [
    candidate.domain,
    searchableUrlMetadata(candidate.source_url),
    candidate.route_path,
    candidate.author,
    candidate.publisher,
  ].filter(Boolean).join(" ");
  const body = `${title} ${summary} ${metadata}`;
  const matchedPrimaryEntities = (context.primaryEntities || [])
    .filter((entity) => matchesRequiredEntity(body, entity))
    .map((entity) => entity.canonical);
  const matchedSecondaryEntityObjects = (context.secondaryEntities || [])
    .filter((entity) => matchesRequiredEntity(body, entity));
  const matchedSecondaryEntities = matchedSecondaryEntityObjects.map((entity) => entity.canonical);
  const required = (context.primaryEntities || []).filter((entity) => entity.required);
  const requiredSecondaryEntities = (context.secondaryEntities || [])
    .filter((entity) => entity.required && entity.type !== "topic");
  const matchedRequiredEntities = required.filter((entity) => matchedPrimaryEntities.includes(entity.canonical));
  // At-least-one semantics: reject only when ZERO required entities match
  if (required.length > 0 && matchedRequiredEntities.length === 0) {
    return { accepted: false, score: 0, matchedPrimaryEntities, matchedSecondaryEntities: [], matchedLockedPhrases: [], matchedNegativeEntities: [], rejectionReason: "missing_required_entity" };
  }
  // At-least-one semantics for required secondary entities
  if (requiredSecondaryEntities.length > 0 && requiredSecondaryEntities.every((entity) => !matchedSecondaryEntities.includes(entity.canonical))) {
    return { accepted: false, score: 0, matchedPrimaryEntities, matchedSecondaryEntities, matchedLockedPhrases: [], matchedNegativeEntities: [], rejectionReason: "missing_required_entity" };
  }

  const matchedNegativeEntities = (context.negativeEntities || []).filter((entity) => matchesExactPhrase(body, entity));
  if (matchedNegativeEntities.length) {
    return { accepted: false, score: -100, matchedPrimaryEntities, matchedSecondaryEntities: [], matchedLockedPhrases: [], matchedNegativeEntities, rejectionReason: "negative_entity_match" };
  }

  const matchedLockedPhrases = (context.lockedPhrases || []).filter((phrase) => matchesExactPhrase(body, phrase));

  const titleScore = (context.primaryEntities || []).reduce((sum, entity) => sum + (matchesRequiredEntity(title, entity) ? 60 : 0), 0);
  const metadataScore = (context.primaryEntities || []).reduce((sum, entity) => sum + (matchesRequiredEntity(metadata, entity) ? 20 : 0), 0);
  const summaryScore = (context.primaryEntities || []).reduce((sum, entity) => sum + (!matchesRequiredEntity(title, entity) && matchesRequiredEntity(summary, entity) ? 45 : 0), 0);
  const lockedScore = matchedLockedPhrases.reduce((sum, phrase) => sum + (matchesExactPhrase(title, phrase) ? 50 : 35), 0);
  const secondaryScore = matchedSecondaryEntities.length * 10;
  const termScore = (context.entityTerms || []).filter((term) => matchesExactPhrase(body, term)).length * 10;
  const topicScore = (context.topics || []).filter((topic) => matchesExactPhrase(body, topic)).length * 3;
  const intentPhrases: Record<string, string[]> = {
    definition: ["overview", "introduction", "what is", "documentation", "explained"],
    explanation: ["overview", "introduction", "what is", "documentation", "explained"],
    implementation: ["quickstart", "integration", "sdk", "api", "install", "configure", "example"],
    comparison: ["comparison", "versus", "vs", "difference"],
    troubleshooting: ["error", "issue", "troubleshoot", "fix", "failed", "failure"],
  };
  const intent = (context.intentType || "").toLowerCase();
  const intentMatches = (intentPhrases[intent] || []).filter((phrase) => matchesExactPhrase(title, phrase));
  const intentSummaryMatches = (intentPhrases[intent] || []).filter((phrase) => matchesExactPhrase(summary, phrase));
  const score = titleScore + metadataScore + summaryScore + lockedScore + secondaryScore + termScore + topicScore + intentMatches.length * 10 + intentSummaryMatches.length * 5 + (candidate.relevance_score || 0);
  if (score <= 0) return { accepted: false, score, matchedPrimaryEntities, matchedSecondaryEntities, matchedLockedPhrases, matchedNegativeEntities, rejectionReason: "zero_or_negative_score" };
  const meaningfulSecondaryMatches = (context.secondaryEntities || [])
    .filter((entity) => entity.type !== "topic")
    .filter((entity) => matchedSecondaryEntities.includes(entity.canonical));
  if (!required.length && !matchedLockedPhrases.length && !matchedPrimaryEntities.length && !meaningfulSecondaryMatches.length && !termScore) {
    return { accepted: false, score, matchedPrimaryEntities, matchedSecondaryEntities, matchedLockedPhrases, matchedNegativeEntities, rejectionReason: "topic_only_match" };
  }
  return { accepted: true, score, matchedPrimaryEntities, matchedSecondaryEntities, matchedLockedPhrases, matchedNegativeEntities };
}

export function validateCandidateRelevance(candidate: RelevanceCandidate, context: Parameters<typeof scoreCandidateRelevance>[1]): RelevanceResult {
  if (!candidate.source_url || !/^https?:\/\//i.test(candidate.source_url)) {
    return { accepted: false, score: 0, matchedPrimaryEntities: [], matchedSecondaryEntities: [], matchedLockedPhrases: [], matchedNegativeEntities: [], rejectionReason: "invalid_url" };
  }
  return scoreCandidateRelevance(candidate, context);
}


// ─── Aspect coverage helper ──────────────────────────────────
// Uses ASPECT_DEFINITIONS from crypto-entity-registry for boundary-aware matching

/**
 * Compute which requested aspects are covered by a set of source texts.
 * Uses ASPECT_DEFINITIONS.signalTerms for boundary-aware phrase matching.
 * Returns { covered, missing } listing the aspects.
 */
/**
 * Check which requested aspects are matched by a single text.
 * Uses ASPECT_DEFINITIONS.signalTerms for boundary-aware phrase matching.
 * Returns the list of matched aspect keys.
 *
 * This is the single shared implementation for:
 * - source-resolver Phase B candidate selection
 * - signal-scout fallback gap detection
 * - final coverage validation
 */
export function getMatchedAspectsForText(
  text: string,
  requestedAspects: RequestedAspectConstraint[] | string[],
): string[] {
  const constraints = normalizeAspectConstraints(requestedAspects);
  return constraints.filter((aspect) => matchesRequestedAspect(text, aspect)).map((aspect) => aspect.key);
}

export function computeAspectCoverage(
  sourceTexts: string[],
  requestedAspects: RequestedAspectConstraint[] | string[],
): { covered: string[]; missing: string[] } {
  const constraints = normalizeAspectConstraints(requestedAspects);
  if (!constraints.length) return { covered: [], missing: [] };
  const combined = sourceTexts.join(" ");
  const covered: string[] = [];
  const missing: string[] = [];
  for (const aspect of constraints) {
    if (matchesRequestedAspect(combined, aspect)) covered.push(aspect.key);
    else missing.push(aspect.key);
  }
  return { covered, missing };
}
