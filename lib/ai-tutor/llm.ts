/**
 * PayLabs Tutor LLM Factory — Per-Agent Routing (15 Agents)
 *
 * Each LangGraph agent can be configured with its own provider, API key,
 * base URL, and model through environment variables.
 *
 * Config resolution order (per field):
 *   provider: PAYLABS_LLM_PROVIDER_<AGENT_KEY> → PAYLABS_LLM_PROVIDER_DEFAULT → "openai"
 *   api key:  PAYLABS_LLM_API_KEY_<AGENT_KEY>  → PAYLABS_LLM_API_KEY_DEFAULT  → PAYLABS_OPENAI_API_KEY → OPENAI_API_KEY
 *   base URL: PAYLABS_LLM_BASE_URL_<AGENT_KEY> → PAYLABS_LLM_BASE_URL_DEFAULT → undefined
 *   model:    PAYLABS_TUTOR_MODEL_<AGENT_KEY>   → PAYLABS_TUTOR_MODEL_DEFAULT  → PAYLABS_TUTOR_MODEL → "gpt-4o-mini"
 *
 * 15 agents:
 *   tutor_intake              → TUTOR_INTAKE
 *   intent_classifier         → INTENT_CLASSIFIER
 *   query_expander            → QUERY_EXPANDER
 *   feed_discovery_agent      → FEED_DISCOVERY
 *   source_ranker             → SOURCE_RANKER
 *   evidence_allocator        → EVIDENCE_ALLOCATOR
 *   stop_limit_controller     → STOP_LIMIT
 *   budget_optimizer          → BUDGET_OPTIMIZER
 *   source_quality_verifier   → SOURCE_QUALITY
 *   provenance_verifier       → PROVENANCE
 *   creator_ownership_verifier→ CREATOR_OWNERSHIP
 *   policy_guard              → POLICY_GUARD
 *   payment_quote_agent       → PAYMENT_QUOTE
 *   payment_executor          → PAYMENT_EXECUTOR
 *   receipt_auditor           → RECEIPT_AUDITOR
 *
 * Recommended routing:
 *   cheap/planning agents: MiMo or cheaper model
 *   critical verification/policy/receipt: strongest model
 *   every agent: deterministic backend checks still apply
 *
 * If PAYLABS_LLM_REQUIRED=true and no API key, throws.
 * No secrets printed.
 */

import { ChatOpenAI } from "@langchain/openai";

// ─── Agent name → env key mapping ──────────────────────────────

const AGENT_KEY_MAP: Record<string, string> = {
  tutor_intake: "TUTOR_INTAKE",
  intent_classifier: "INTENT_CLASSIFIER",
  query_expander: "QUERY_EXPANDER",
  feed_discovery_agent: "FEED_DISCOVERY",
  source_ranker: "SOURCE_RANKER",
  evidence_allocator: "EVIDENCE_ALLOCATOR",
  stop_limit_controller: "STOP_LIMIT",
  budget_optimizer: "BUDGET_OPTIMIZER",
  source_quality_verifier: "SOURCE_QUALITY",
  provenance_verifier: "PROVENANCE",
  creator_ownership_verifier: "CREATOR_OWNERSHIP",
  policy_guard: "POLICY_GUARD",
  payment_quote_agent: "PAYMENT_QUOTE",
  payment_executor: "PAYMENT_EXECUTOR",
  receipt_auditor: "RECEIPT_AUDITOR",
};

// ─── Per-config cache ──────────────────────────────────────────
// Key: "${provider}:${baseUrl || "default"}:${model}:${agentKey}"
// Never includes raw API key.

const modelCache = new Map<string, ChatOpenAI>();

// ─── Internal helpers ──────────────────────────────────────────

function envOrDefault(suffix: string, fallback?: string): string | undefined {
  return process.env[suffix] ?? fallback;
}

function resolveConfig(agentName?: string): {
  provider: string;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string;
  agentKey: string;
} {
  const agentKey = agentName
    ? AGENT_KEY_MAP[agentName] || agentName.toUpperCase()
    : "DEFAULT";

  const provider =
    envOrDefault(`PAYLABS_LLM_PROVIDER_${agentKey}`) ??
    envOrDefault("PAYLABS_LLM_PROVIDER_DEFAULT") ??
    "openai";

  const apiKey =
    envOrDefault(`PAYLABS_LLM_API_KEY_${agentKey}`) ??
    envOrDefault("PAYLABS_LLM_API_KEY_DEFAULT") ??
    envOrDefault("PAYLABS_OPENAI_API_KEY") ??
    envOrDefault("OPENAI_API_KEY");

  const baseUrl =
    envOrDefault(`PAYLABS_LLM_BASE_URL_${agentKey}`) ??
    envOrDefault("PAYLABS_LLM_BASE_URL_DEFAULT");

  const model =
    envOrDefault(`PAYLABS_TUTOR_MODEL_${agentKey}`) ??
    envOrDefault("PAYLABS_TUTOR_MODEL_DEFAULT") ??
    envOrDefault("PAYLABS_TUTOR_MODEL") ??
    "gpt-4o-mini";

  return { provider, apiKey, baseUrl, model, agentKey };
}

function buildCacheKey(cfg: {
  provider: string;
  baseUrl?: string;
  model: string;
  agentKey: string;
}): string {
  return `${cfg.provider}:${cfg.baseUrl || "default"}:${cfg.model}:${cfg.agentKey}`;
}

// ─── Public API ────────────────────────────────────────────────

export function getTutorModel(agentName?: string): ChatOpenAI | null {
  const cfg = resolveConfig(agentName);
  const llmRequired = process.env.PAYLABS_LLM_REQUIRED === "true";

  if (!cfg.apiKey) {
    if (llmRequired) {
      throw new Error(
        `PAYLABS_LLM_REQUIRED=true but no API key found for agent [${cfg.agentKey}]. ` +
          `Set PAYLABS_LLM_API_KEY_${cfg.agentKey} or PAYLABS_LLM_API_KEY_DEFAULT or PAYLABS_OPENAI_API_KEY.`
      );
    }
    return null;
  }

  const cacheKey = buildCacheKey(cfg);
  const cached = modelCache.get(cacheKey);
  if (cached) return cached;

  const model = new ChatOpenAI({
    model: cfg.model,
    apiKey: cfg.apiKey,
    temperature: 0,
    maxTokens: 2048,
    ...(cfg.baseUrl
      ? { configuration: { baseURL: cfg.baseUrl } }
      : {}),
  });

  modelCache.set(cacheKey, model);
  return model;
}

export function getTutorModelName(agentName?: string): string {
  return resolveConfig(agentName).model;
}

export function getTutorModelConfig(agentName?: string): {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKeyPresent: boolean;
  agentKey: string;
} {
  const cfg = resolveConfig(agentName);
  return {
    provider: cfg.provider,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    apiKeyPresent: !!cfg.apiKey,
    agentKey: cfg.agentKey,
  };
}

export function isLlmRequired(): boolean {
  return process.env.PAYLABS_LLM_REQUIRED === "true";
}

/**
 * Get all registered agent names (for iteration/diagnostics).
 */
export function getRegisteredAgentNames(): string[] {
  return Object.keys(AGENT_KEY_MAP);
}
