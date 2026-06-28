/**
 * PayLabs Tutor LLM Factory — Per-Agent Routing (15 Agents)
 *
 * Each LangGraph agent can be configured with its own provider, API key,
 * base URL, model, timeout, and maxTokens through environment variables.
 *
 * Config resolution order (per field):
 *   provider:   PAYLABS_LLM_PROVIDER_<AGENT_KEY> → PAYLABS_LLM_PROVIDER_DEFAULT → "openai"
 *   api key:    PAYLABS_LLM_API_KEY_<AGENT_KEY>  → PAYLABS_LLM_API_KEY_DEFAULT  → PAYLABS_OPENAI_API_KEY → OPENAI_API_KEY
 *   base URL:   PAYLABS_LLM_BASE_URL_<AGENT_KEY> → PAYLABS_LLM_BASE_URL_DEFAULT → undefined
 *   model:      PAYLABS_TUTOR_MODEL_<AGENT_KEY>   → PAYLABS_TUTOR_MODEL_DEFAULT  → PAYLABS_TUTOR_MODEL → "gpt-4o-mini"
 *   timeout:    PAYLABS_LLM_TIMEOUT_<AGENT_KEY>   → PAYLABS_LLM_TIMEOUT_DEFAULT  → PAYLABS_LLM_TIMEOUT_MS → 20000
 *   maxTokens:  PAYLABS_LLM_MAX_TOKENS_<AGENT_KEY> → PAYLABS_LLM_MAX_TOKENS_DEFAULT → PAYLABS_LLM_MAX_TOKENS → 1024
 *   streaming:  PAYLABS_LLM_STREAMING_<AGENT_KEY> → PAYLABS_LLM_STREAMING_DEFAULT → false
 *
 * If PAYLABS_LLM_REQUIRED=true and no API key, throws.
 * No secrets printed.
 */

import { ChatOpenAI } from "@langchain/openai";

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
  brain_planner: "BRAIN_PLANNER",
  intent_planner: "INTENT_PLANNER",
  query_builder: "QUERY_BUILDER",
  signal_scout: "SIGNAL_SCOUT",
  intent_matcher: "INTENT_MATCHER",
  source_verifier: "SOURCE_VERIFIER",
  value_allocator: "VALUE_ALLOCATOR",
  trust_verifier: "TRUST_VERIFIER",
  advanced_evidence_evaluator: "ADVANCED_EVIDENCE_EVALUATOR",
};

const modelCache = new Map<string, ChatOpenAI>();

function envOrDefault(suffix: string, fallback?: string): string | undefined {
  const v = process.env[suffix];
  if (v === undefined || v === "") return fallback;
  return v;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveBooleanConfig(agentKey: string, baseName: string, fallback: boolean): boolean {
  const raw = envOrDefault(`${baseName}_${agentKey}`) ??
    envOrDefault(`${baseName}_DEFAULT`) ??
    envOrDefault(baseName);
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === "true";
}

function resolveNumberConfig(agentKey: string, baseName: string, fallback: number): number {
  return envNumber(`${baseName}_${agentKey}`, envNumber(`${baseName}_DEFAULT`, envNumber(baseName, fallback)));
}

export function resolveConfig(agentName?: string): {
  provider: string;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string;
  agentKey: string;
  timeoutMs: number;
  maxTokens: number;
  streaming: boolean;
} {
  const agentKey = agentName ? AGENT_KEY_MAP[agentName] || agentName.toUpperCase() : "DEFAULT";
  const provider = envOrDefault(`PAYLABS_LLM_PROVIDER_${agentKey}`) ?? envOrDefault("PAYLABS_LLM_PROVIDER_DEFAULT") ?? "openai";
  const apiKey = envOrDefault(`PAYLABS_LLM_API_KEY_${agentKey}`) ?? envOrDefault("PAYLABS_LLM_API_KEY_DEFAULT") ?? envOrDefault("PAYLABS_OPENAI_API_KEY") ?? envOrDefault("OPENAI_API_KEY");
  const baseUrl = envOrDefault(`PAYLABS_LLM_BASE_URL_${agentKey}`) ?? envOrDefault("PAYLABS_LLM_BASE_URL_DEFAULT");
  const model = envOrDefault(`PAYLABS_TUTOR_MODEL_${agentKey}`) ?? envOrDefault("PAYLABS_TUTOR_MODEL_DEFAULT") ?? envOrDefault("PAYLABS_TUTOR_MODEL") ?? "gpt-4o-mini";
  const timeoutMs = resolveNumberConfig(agentKey, "PAYLABS_LLM_TIMEOUT_MS", 20000);
  const maxTokens = resolveNumberConfig(agentKey, "PAYLABS_LLM_MAX_TOKENS", 1024);
  const streaming = resolveBooleanConfig(agentKey, "PAYLABS_LLM_STREAMING", false);

  return { provider, apiKey, baseUrl, model, agentKey, timeoutMs, maxTokens, streaming };
}

function buildCacheKey(cfg: {
  provider: string;
  baseUrl?: string;
  model: string;
  agentKey: string;
  timeoutMs: number;
  maxTokens: number;
  streaming: boolean;
}): string {
  return `${cfg.provider}:${cfg.baseUrl || "default"}:${cfg.model}:${cfg.agentKey}:${cfg.timeoutMs}:${cfg.maxTokens}:${cfg.streaming}`;
}

export function getTutorModel(agentName?: string): ChatOpenAI | null {
  const cfg = resolveConfig(agentName);
  const llmRequired = process.env.PAYLABS_LLM_REQUIRED === "true";

  if (!cfg.apiKey) {
    if (llmRequired) throw new Error(`PAYLABS_LLM_REQUIRED=true but no API key for [${cfg.agentKey}].`);
    return null;
  }

  const cacheKey = buildCacheKey(cfg);
  const cached = modelCache.get(cacheKey);
  if (cached) return cached;

  const model = new ChatOpenAI({
    model: cfg.model,
    apiKey: cfg.apiKey,
    temperature: 0,
    maxTokens: cfg.maxTokens,
    timeout: cfg.timeoutMs,
    streaming: cfg.streaming,
    ...(cfg.baseUrl ? { configuration: { baseURL: cfg.baseUrl } } : {}),
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
  timeoutMs: number;
  maxTokens: number;
  streaming: boolean;
} {
  const cfg = resolveConfig(agentName);
  return {
    provider: cfg.provider,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    apiKeyPresent: !!cfg.apiKey,
    agentKey: cfg.agentKey,
    timeoutMs: cfg.timeoutMs,
    maxTokens: cfg.maxTokens,
    streaming: cfg.streaming,
  };
}

export function isLlmRequired(): boolean {
  return process.env.PAYLABS_LLM_REQUIRED === "true";
}

export function getRegisteredAgentNames(): string[] {
  return Object.keys(AGENT_KEY_MAP);
}
