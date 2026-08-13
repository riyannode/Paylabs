import {
  ASPECT_DEFINITIONS,
  getSharedEntityIdentities,
  resolveContextualEntity,
} from "./crypto-entity-registry";

export type QuerySubjectType =
  | "protocol"
  | "token"
  | "chain"
  | "company"
  | "product"
  | "standard"
  | "concept"
  | "named_subject";

export type QuerySubjectConstraint = {
  text: string;
  canonical: string;
  type: QuerySubjectType;
  required: boolean;
  explicit: boolean;
};

export type RequestedAspectConstraint = {
  key: string;
  label: string;
  sourceText: string;
  matchTerms: string[];
  knownDefinitionKey?: string;
};

export type TemporalConstraint = {
  kind: "last_days" | "last_weeks" | "last_months" | "since" | "year" | "between";
  hard: boolean;
  start?: string;
  end?: string;
  value?: number;
  unit?: string;
  sourceText: string;
};

export type QueryOperation = "explain" | "compare" | "current" | "factual" | "unknown";

export type QueryRequirements = {
  comparisonLike: boolean;
  operation: QueryOperation;
  explicitSubjects: QuerySubjectConstraint[];
  requestedAspects: RequestedAspectConstraint[];
  temporalConstraint: TemporalConstraint | null;
  requirementsValid: boolean;
  extractionWarnings: string[];
};

export type QuerySubjectProjection = {
  text: string;
  canonical: string;
  type: QuerySubjectType;
  required: boolean;
};

const SUBJECT_STOP_WORDS = /\b(?:as|for|regarding|concerning|in|on|about|where|how|what|which|that)\b/i;
const NAMED_SUBJECT_TYPES = new Set<QuerySubjectType>([
  "protocol",
  "token",
  "chain",
  "company",
  "product",
  "standard",
  "named_subject",
]);

const ASPECT_ALIASES: Record<string, string> = {
  "reserve model": "reserve_model",
  reserve: "reserve_model",
  "reserve structure": "collateral_structure",
  "collateral structure": "collateral_structure",
  issuance: "issuance",
  "issuance and redemption": "issuance",
  "redemption mechanism": "redemption_mechanism",
  redemption: "redemption_mechanism",
  "congestion behavior": "congestion",
  "scalability approach": "scalability",
  "scalability approaches": "scalability",
  "congestion behaviors": "congestion",
  "security assumption": "security_assumption",
  "major tradeoff": "major_tradeoff",
  "major tradeoffs": "major_tradeoff",
  transparency: "transparency",
  "depeg risk": "depeg_risk",
  "counterparty risk": "counterparty_risk",
  "regulatory risk": "regulatory_risk",
  "knowledge freshness": "knowledge_freshness",
  "hallucination risk": "hallucination_risk",
  "lp fee economics": "lp_fee_economics",
  "amm design": "amm_design",
  "pricing mechanism": "pricing_mechanism",
  "liquidity model": "liquidity_model",
  "impermanent loss": "impermanent_loss",
  "impermanent loss exposure": "impermanent_loss",
  "mev risk": "mev",
  "validator incentive": "validator_incentives",
  "lending model": "lending_model",
  "collateral rule": "collateral",
  "liquidation mechanism": "liquidation",
  "interest-rate model": "interest_rates",
  "major protocol risk": "protocol_risks",
  "maintenance requirement": "maintenance",
  collateralization: "collateral",
  "base fee": "base_fee",
  "priority fee": "priority_fee",
  "interest rate": "interest_rates",
  "protocol risk": "protocol_risks",
  "peg stability": "peg_stability",
  "peg stability mechanism": "peg_stability",
  "savings mechanism": "savings_yield",
  "yield mechanism": "savings_yield",
  "trader impact": "trader_impact",
  "liquidity provider impact": "lp_impact",
  "lp impact": "lp_impact",
  "sandwich attack": "sandwich_attack",
  arbitrage: "arbitrage",
  liquidation: "liquidation",
  mining: "mining",
  mev: "mev",
  cost: "cost",
  latency: "latency",
  maintenance: "maintenance",
  security: "security",
  fees: "fees",
};

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}\s_/-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singularizeLastWord(value: string): string {
  const words = value.split(" ").filter(Boolean);
  if (!words.length) return value;
  const last = words[words.length - 1];
  if (last.endsWith("ies") && last.length > 4) words[words.length - 1] = `${last.slice(0, -3)}y`;
  else if (last.endsWith("ses") && last.length > 4) words[words.length - 1] = last.slice(0, -2);
  else if (last.endsWith("s") && !last.endsWith("ss") && last.length > 3) words[words.length - 1] = last.slice(0, -1);
  return words.join(" ");
}

function phraseVariants(value: string): string[] {
  const normalized = normalizeKey(value);
  const singular = singularizeLastWord(normalized);
  const variants = new Set([normalized, singular]);
  if (singular && !singular.endsWith("s")) variants.add(`${singular}s`);
  return [...variants].filter(Boolean);
}

function matchesBoundary(text: string, term: string): boolean {
  const haystack = ` ${normalizeKey(text)} `;
  return phraseVariants(term).some((variant) => haystack.includes(` ${variant} `));
}

function keyForAspect(phrase: string): { key: string; knownDefinitionKey?: string } {
  const normalized = singularizeLastWord(normalizeKey(phrase));
  const alias = ASPECT_ALIASES[normalized] || ASPECT_ALIASES[normalizeKey(phrase)];
  if (alias) return { key: alias, knownDefinitionKey: ASPECT_DEFINITIONS[alias] ? alias : undefined };

  for (const [key, definition] of Object.entries(ASPECT_DEFINITIONS)) {
    if (definition.signalTerms.some((term) => phraseVariants(term).includes(normalized))) {
      return { key, knownDefinitionKey: key };
    }
  }

  return { key: normalized.replace(/\s+/g, "_") };
}

function deriveImpactMatchTerms(sourceText: string): string[] {
  const normalized = normalizeKey(sourceText);
  const actorMatch = normalized.match(/^(.+?)\s+impact$/);
  if (!actorMatch) return [];

  const actorVariants = phraseVariants(actorMatch[1]);
  const variants = new Set<string>();
  for (const actor of actorVariants) {
    variants.add(actor);
    variants.add(`${actor} impact`);
    variants.add(`impact on ${actor}`);
    variants.add(`effect on ${actor}`);
    variants.add(`effects on ${actor}`);
    variants.add(`affect ${actor}`);
    variants.add(`affects ${actor}`);
  }
  return [...variants];
}

function buildAspectConstraint(sourceText: string): RequestedAspectConstraint {
  const cleanSource = normalizeText(sourceText).toLowerCase();
  const { key, knownDefinitionKey } = keyForAspect(cleanSource);
  const definition = knownDefinitionKey ? ASPECT_DEFINITIONS[knownDefinitionKey] : undefined;
  const matchTerms = new Set<string>([
    cleanSource,
    singularizeLastWord(cleanSource),
    ...deriveImpactMatchTerms(cleanSource),
  ]);
  if (definition) {
    for (const term of definition.signalTerms) matchTerms.add(term);
  }
  return {
    key,
    label: definition?.label || cleanSource.replace(/\b\w/g, (letter) => letter.toUpperCase()),
    sourceText: cleanSource,
    matchTerms: [...matchTerms].filter(Boolean),
    ...(knownDefinitionKey ? { knownDefinitionKey } : {}),
  };
}

function splitCoordinatedDimensions(text: string): string[] {
  let value = text
    .normalize("NFKC")
    .replace(/[.!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  value = value.replace(/^(?:and\s+)?(?:their|the|major|respective|each one|explain)\s+/i, "");
  value = value.replace(/\band\s+how\b.*$/i, "");
  if (!value) return [];

  const parts = value.split(/\s*,\s*|\s+and\s+/i).map((part) => part.replace(/^and\s+(?:the\s+)?/i, "").trim()).filter(Boolean);
  return parts.flatMap((part) => {
    const alternatives = part.split(/\s+or\s+/i).map((item) => item.trim()).filter(Boolean);
    if (alternatives.length < 2) return [part];
    const sharedHead = alternatives[alternatives.length - 1].match(/\b(models?|mechanisms?|requirements?|rules?|risks?|fees?|attacks?|liquidations?|incentives?)$/i)?.[1];
    return sharedHead
      ? alternatives.map((item) => new RegExp(`\\b${sharedHead}$`, "i").test(item) ? item : `${item} ${sharedHead}`)
      : alternatives;
  });
}

function extractExplicitAspectPhrases(goal: string): string[] {
  const phrases: string[] = [];
  const patterns = [
    /\bhow\s+do\s+(?:their|theirs|these|those)\s+(.+?)\s+differ\b/gi,
    /\bhow\s+do\s+(.+?)\s+differ\b/gi,
    /\b(?:differ|differs|differences?)\s+in\s+([^.!?]+)/gi,

    /\b(?:regarding|concerning|in terms of|with respect to)\s+(?!how\b)([^.!?]+)/gi,
    /\bfor\s+(fees?)\b/gi,
    /\b(?:cover|covering)\s+([^.!?]+)/gi,
    /\bexplain\s+(?!how\b)([^.!?]+)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of goal.matchAll(pattern)) {
      phrases.push(...splitCoordinatedDimensions(match[1]));
    }
  }

  // Some concise comparison queries omit "regarding"/"differ" and place
  // generic dimensions directly after the second subject, e.g. "Compare A
  // and B latency, cost, and security". Recover only that trailing span when
  // no stronger aspect grammar already produced constraints. The subject
  // parser remains responsible for identifying the second explicit subject.
  if (phrases.length === 0) {
    const comparison = goal.match(/\bcompare\s+.+?\s+(?:and|with)\s+(.+?)(?:[.!?]|$)/i);
    if (comparison) {
      const secondSubject = trimSubjectCandidate(comparison[1]);
      const trailingDimensions = comparison[1].slice(secondSubject.length).trim();
      if (
        trailingDimensions
        && !/^(?:as|for)\b/i.test(trailingDimensions)
        && !/^(?:regarding|concerning|in terms of|with respect to)\b/i.test(trailingDimensions)
        && !/\baffects?\b/i.test(trailingDimensions)
      ) {
        phrases.push(...splitCoordinatedDimensions(trailingDimensions));
      }
    }
  }

  const impact = goal.match(/\baffects?\s+([^.!?]+)/i)?.[1];
  if (impact) {
    for (const part of splitCoordinatedDimensions(impact)) {
      const actor = singularizeLastWord(
        normalizeKey(part).replace(/^(?:the|their|these|those|respective)\s+/i, ""),
      );
      if (actor) phrases.push(`${actor} impact`);
    }
  }

  return phrases;
}

function extractRequestedAspectConstraints(goal: string): RequestedAspectConstraint[] {
  const constraints: RequestedAspectConstraint[] = [];
  const seen = new Set<string>();
  const add = (sourceText: string) => {
    const constraint = buildAspectConstraint(sourceText);
    if (/^(?:they|their|these|those|theirs)$/i.test(constraint.sourceText)) return;
    if (!constraint.key || seen.has(constraint.key)) return;
    seen.add(constraint.key);
    constraints.push(constraint);
  };

  for (const phrase of extractExplicitAspectPhrases(goal)) add(phrase);

  // These are explicit technical subjects/concepts, not generic question words.
  if (matchesBoundary(goal, "mining") || matchesBoundary(goal, "miners")) add("mining");
  if (matchesBoundary(goal, "MEV") || matchesBoundary(goal, "maximal extractable value")) add("MEV");

  return constraints;
}

function allKnownEntityEntries(): Array<{ canonical: string; aliases: string[]; type: QuerySubjectType }> {
  return getSharedEntityIdentities().map((entry) => ({
    canonical: entry.canonical,
    aliases: entry.aliases,
    type: entry.type as QuerySubjectType,
  }));
}

function trimSubjectCandidate(candidate: string): string {
  let value = normalizeText(candidate).trim();
  value = value.replace(/^\s*and\s+/i, "");
  value = value.replace(/^\s*(?:the|their|its)\s+/i, "");
  value = value.split(/\s+as\s+/i)[0].trim();
  value = value.split(SUBJECT_STOP_WORDS)[0].trim();
  value = value.replace(/[.,;:!?]+$/, "").trim();

  const known = allKnownEntityEntries()
    .flatMap((entry) => entry.aliases.map((alias) => ({ alias, canonical: entry.canonical })))
    .sort((a, b) => b.alias.length - a.alias.length);
  const lower = value.toLowerCase();
  const ambiguousAliases = new Set(["compound", "maker", "curve"]);
  const knownStart = known.find((entry) => {
    const aliasLower = entry.alias.toLowerCase();
    if (ambiguousAliases.has(aliasLower) && lower !== aliasLower) return false;
    return lower === aliasLower || lower.startsWith(`${aliasLower} `);
  });
  if (knownStart) return value.slice(0, knownStart.alias.length);

  const camel = value.match(/[A-Z][A-Za-z0-9_-]{3,}/);
  if (camel && value.toLowerCase().startsWith(camel[0].toLowerCase())) return camel[0];
  return value;
}

function comparisonSubjectCandidates(goal: string): { comparisonLike: boolean; candidates: string[] } {
  const patterns = [
    /\bcompare\s+(.+?)(?=[.!?]|$)/i,
    /\b(?:difference|differences)\s+between\s+(.+?)\s+and\s+(.+?)(?=[.!?]|$)/i,
    /\bhow\s+do\s+(.+?)\s+and\s+(.+?)\s+differ\b/i,
    /\b(.+?)\s+(?:vs\.?|versus)\s+(.+?)(?=[.!?]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = goal.match(pattern);
    if (!match) continue;
    const clause = match[1];
    const subjectSpan = clause
      .split(/\s+(?:for|as|regarding|concerning|in terms of|with respect to)\b/i)[0]
      .replace(/\s+and\s*$/i, "");
    const candidates = splitSubjectVariants(subjectSpan);
    if (candidates.length < 2 && match[2]) {
      candidates.push(trimSubjectCandidate(match[2]));
    }
    return { comparisonLike: true, candidates };
  }
  return { comparisonLike: false, candidates: [] };
}

function splitSubjectVariants(candidate: string): string[] {
  return candidate
    .split(/\s*\/\s*|\s+or\s+|\s*,\s*|\s+and\s+/i)
    .map((part) => trimSubjectCandidate(part))
    .filter(Boolean);
}

function resolveSubject(text: string, goal: string): QuerySubjectConstraint {
  const cleanText = normalizeText(text);
  const lower = cleanText.toLowerCase();
  const known = allKnownEntityEntries()
    .sort((a, b) => Math.max(...b.aliases.map((alias) => alias.length)) - Math.max(...a.aliases.map((alias) => alias.length)));
  const match = known.find((entry) => entry.aliases.some((alias) => alias.toLowerCase() === lower));

  if (match) {
    return { text: cleanText, canonical: match.canonical, type: match.type, required: true, explicit: true };
  }

  const contextual = resolveContextualEntity(cleanText, goal);
  if (contextual) {
    return {
      text: cleanText,
      canonical: contextual.canonical,
      type: contextual.entityType === "protocol" ? "protocol" : "concept",
      required: true,
      explicit: true,
    };
  }

  return { text: cleanText, canonical: cleanText, type: "named_subject", required: true, explicit: true };
}

function extractKnownNamedSubjects(goal: string): QuerySubjectConstraint[] {
  const lower = goal.toLowerCase();
  const subjects: QuerySubjectConstraint[] = [];
  const seen = new Set<string>();
  const known = allKnownEntityEntries()
    .filter((entry) => NAMED_SUBJECT_TYPES.has(entry.type))
    .sort((a, b) => Math.max(...b.aliases.map((alias) => alias.length)) - Math.max(...a.aliases.map((alias) => alias.length)));

  for (const entry of known) {
    for (const alias of entry.aliases) {
      const aliasLower = alias.toLowerCase();
      // These short spellings are ordinary-language homonyms. They only
      // become required named entities when the shared contextual resolver
      // authorizes the protocol identity from the surrounding goal.
      if (
        ["compound", "curve", "maker", "balancer"].includes(aliasLower)
        && resolveContextualEntity(alias, goal)?.canonical !== entry.canonical
      ) continue;
      const escaped = aliasLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "iu").test(lower)) continue;
      if (seen.has(entry.canonical.toLowerCase())) break;
      subjects.push({ text: alias, canonical: entry.canonical, type: entry.type, required: true, explicit: true });
      seen.add(entry.canonical.toLowerCase());
      break;
    }
  }
  return subjects;
}

/**
 * Preserve explicit named technical subjects that are not part of the crypto
 * identity registry. These are deliberately narrow: generic concepts such as
 * AMM, MEV, and lending remain optional/aspect context unless the comparison
 * grammar makes them explicit subjects.
 */
function extractExplicitTechnicalSubjects(goal: string): QuerySubjectConstraint[] {
  const candidates = [
    { canonical: "retrieval-augmented generation", aliases: ["retrieval-augmented generation", "retrieval augmented generation"] },
    { canonical: "fine-tuning", aliases: ["fine-tuning", "fine tuning"] },
  ];
  const subjects: QuerySubjectConstraint[] = [];
  for (const candidate of candidates) {
    const matchedAlias = candidate.aliases.find((alias) => matchesBoundary(goal, alias));
    if (!matchedAlias) continue;
    subjects.push({
      text: matchedAlias,
      canonical: candidate.canonical,
      type: "named_subject",
      required: true,
      explicit: true,
    });
  }
  return subjects;
}

function extractTemporalConstraint(goal: string): TemporalConstraint | null {
  const source = goal.match(/\b(?:last|past)\s+(\d+)\s+(day|days|week|weeks|month|months)\b/i);
  if (source) {
    const unit = source[2].toLowerCase().replace(/s$/, "");
    return {
      kind: unit === "day" ? "last_days" : unit === "week" ? "last_weeks" : "last_months",
      hard: true,
      value: Number(source[1]),
      unit,
      sourceText: source[0],
    };
  }

  const since = goal.match(/\bsince\s+((?:20\d{2}-\d{2}-\d{2})|(?:[A-Za-z]+\s+20\d{2})|(?:20\d{2}))\b/i);
  if (since) return { kind: "since", hard: true, start: since[1], sourceText: since[0] };

  const year = goal.match(/\bin\s+(20\d{2})\b/i);
  if (year) return { kind: "year", hard: true, start: year[1], end: year[1], sourceText: year[0] };

  const between = goal.match(/\bbetween\s+(\d{4}-\d{2}-\d{2})\s+and\s+(\d{4}-\d{2}-\d{2})\b/i);
  if (between) return { kind: "between", hard: true, start: between[1], end: between[2], sourceText: between[0] };

  return null;
}

export function deriveQueryOperation(goal: string, comparisonLike = false): QueryOperation {
  if (comparisonLike || /\bcompare|comparison|versus|\bvs\.?\b|differences?\b/i.test(goal)) return "compare";
  if (/\b(today|currently|current|latest|recent|now|this week|this month)\b/i.test(goal)) return "current";
  if (/\b(explain|how does|how do|how .* work|fundamentals?|mechanism|understand)\b/i.test(goal)) return "explain";
  if (/\b(what is|what are|who is|status|define|when did|which)\b/i.test(goal)) return "factual";
  return "unknown";
}

export function extractQueryRequirements(originalGoal: string): QueryRequirements {
  const goal = originalGoal.trim();
  const comparison = comparisonSubjectCandidates(goal);
  const subjects = comparison.comparisonLike
    ? comparison.candidates.flatMap((candidate) => splitSubjectVariants(candidate).map((part) => resolveSubject(part, goal)))
    : [...extractKnownNamedSubjects(goal), ...extractExplicitTechnicalSubjects(goal)];

  const explicitSubjects: QuerySubjectConstraint[] = [];
  const seenSubjects = new Set<string>();
  for (const subject of subjects) {
    const key = subject.canonical.toLowerCase();
    if (!seenSubjects.has(key)) {
      seenSubjects.add(key);
      explicitSubjects.push(subject);
    }
  }

  const subjectText = new Set(explicitSubjects.flatMap((subject) => [subject.text.toLowerCase(), subject.canonical.toLowerCase()]));
  const requestedAspects = extractRequestedAspectConstraints(goal).filter((aspect) => !subjectText.has(aspect.sourceText));
  const temporalConstraint = extractTemporalConstraint(goal);
  const extractionWarnings: string[] = [];
  if (comparison.comparisonLike && explicitSubjects.length < 2) {
    extractionWarnings.push("comparison_subject_count_below_two");
  }
  if (comparison.comparisonLike && requestedAspects.length === 0 && /\b(?:differ|differences?|regarding|cover|covering)\b/i.test(goal)) {
    extractionWarnings.push("explicit_dimension_list_empty");
  }
  if (/\b(?:last|past)\s+\d+\s+(?:days?|weeks?|months?)\b|\bsince\s+20\d{2}|\bin\s+20\d{2}\b|\bbetween\s+\d{4}-\d{2}-\d{2}/i.test(goal) && !temporalConstraint) {
    extractionWarnings.push("hard_temporal_expression_not_parsed");
  }

  return {
    comparisonLike: comparison.comparisonLike,
    operation: deriveQueryOperation(goal, comparison.comparisonLike),
    explicitSubjects,
    requestedAspects,
    temporalConstraint,
    requirementsValid: extractionWarnings.length === 0,
    extractionWarnings: extractionWarnings.slice(0, 8),
  };
}

export function getRequestedAspectKeys(requirements: QueryRequirements): string[] {
  return requirements.requestedAspects.map((aspect) => aspect.key);
}

export function projectRequiredSubjects(requirements: QueryRequirements): QuerySubjectProjection[] {
  return requirements.explicitSubjects
    .filter((subject) => subject.required)
    .map((subject) => ({
      text: subject.text,
      canonical: subject.canonical,
      type: subject.type,
      required: true,
    }));
}

export function normalizeAspectConstraints(
  aspects: RequestedAspectConstraint[] | string[] | undefined,
): RequestedAspectConstraint[] {
  if (!aspects) return [];
  return aspects.map((aspect) => typeof aspect === "string" ? buildAspectConstraint(aspect) : aspect);
}

export function matchesRequestedAspect(text: string, aspect: RequestedAspectConstraint): boolean {
  return aspect.matchTerms.some((term) => matchesBoundary(text, term));
}

export function appendHardTemporalScope(query: string, temporalConstraint: TemporalConstraint | null): string {
  if (!temporalConstraint?.hard) return query;
  if (matchesBoundary(query, temporalConstraint.sourceText)) return query;
  return `${query} ${temporalConstraint.sourceText}`.trim();
}

export function queryPreservesTemporalScope(query: string, temporalConstraint: TemporalConstraint | null): boolean {
  if (!temporalConstraint?.hard) return true;
  return matchesBoundary(query, temporalConstraint.sourceText);
}

export type TemporalEvaluation = {
  usable: boolean;
  inWindow: boolean;
};

function parseTemporalDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  const monthYear = value.match(/^([A-Za-z]+)\s+(20\d{2})$/);
  if (monthYear) {
    const fallback = new Date(`${monthYear[1]} 1, ${monthYear[2]} UTC`);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }
  return null;
}

export function evaluateTemporalConstraint(
  publishedAt: string | null | undefined,
  constraint: TemporalConstraint | null,
  now: Date = new Date(),
): TemporalEvaluation {
  if (!constraint?.hard) return { usable: true, inWindow: true };
  const published = parseTemporalDate(publishedAt || undefined);
  if (!published) return { usable: false, inWindow: false };

  let start: Date | null = null;
  let end: Date | null = null;
  if (constraint.kind === "last_days" || constraint.kind === "last_weeks" || constraint.kind === "last_months") {
    start = new Date(now.getTime());
    if (constraint.kind === "last_months") start.setUTCMonth(start.getUTCMonth() - (constraint.value || 0));
    else start.setUTCDate(start.getUTCDate() - (constraint.value || 0) * (constraint.kind === "last_weeks" ? 7 : 1));
    end = now;
  } else if (constraint.kind === "year") {
    const year = Number(constraint.start);
    if (!Number.isFinite(year)) return { usable: true, inWindow: false };
    start = new Date(Date.UTC(year, 0, 1));
    end = new Date(Date.UTC(year + 1, 0, 1));
  } else {
    start = parseTemporalDate(constraint.start);
    end = parseTemporalDate(constraint.end);
    if (constraint.kind === "since") end = now;
    if (constraint.kind === "between" && end) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }
  if (!start) return { usable: true, inWindow: false };
  const publishedTime = published.getTime();
  return { usable: true, inWindow: publishedTime >= start.getTime() && (!end || publishedTime < end.getTime()) };
}

export function isRequirementsCoverageComplete(requirements: QueryRequirements, checks: {
  allSubjectsCovered: boolean;
  allAspectsCovered: boolean;
  temporalCoverageOk: boolean;
}): boolean {
  return requirements.requirementsValid
    && checks.allSubjectsCovered
    && checks.allAspectsCovered
    && checks.temporalCoverageOk;
}
