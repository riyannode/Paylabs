import { getTutorModel, getTutorModelConfig, isLlmRequired } from "@/lib/ai/llm";

const cfg = getTutorModelConfig("brain_planner");
const model = getTutorModel("brain_planner");
const required = isLlmRequired();

const NATIVE_STRUCTURED_PROVIDERS = new Set(["openai", "anthropic", "mimo"]);
const supportsNative = NATIVE_STRUCTURED_PROVIDERS.has(cfg.provider.toLowerCase());

console.log(JSON.stringify({
  provider: cfg.provider,
  model: cfg.model,
  baseUrl: cfg.baseUrl ? "(present)" : "(missing)",
  apiKeyPresent: cfg.apiKeyPresent,
  agentKey: cfg.agentKey,
  streaming: cfg.streaming,
  maxTokens: cfg.maxTokens,
  timeoutMs: cfg.timeoutMs,
  llmRequired: required,
  supportsNativeStructured: supportsNative,
  hasModel: !!model,
}));
