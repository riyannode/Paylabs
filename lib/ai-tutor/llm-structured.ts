/**
 * Provider-Safe Structured JSON Adapter for PayLabs LLM Agents
 *
 * Replaces direct withStructuredOutput() usage with a provider-safe approach:
 * 1. Try native structured output for providers that support it (OpenAI, etc.)
 * 2. Fallback to raw .invoke() with JSON extraction
 * 3. Parse JSON from: content, fenced blocks, content arrays, reasoning_content
 * 4. MiMo returns reasoning_content + empty content → LLM_STRUCTURED_OUTPUT_PARSE_FAILED
 * 5. Always Zod-validate
 * 6. No secrets in logs, no full prompt dumps in errors
 */

import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { ChatOpenAI } from "@langchain/openai";
import { getTutorModel, getTutorModelName, getTutorModelConfig, isLlmRequired } from "./llm";
import type { RouteTier } from "./route-config";

// ─── Types ──────────────────────────────────────────────────────

export interface GenerateStructuredJsonInput {
  agentName: string;
  routeTier: RouteTier;
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodType<unknown>;
}

export interface GenerateStructuredJsonOk<T> {
  ok: true;
  data: T;
  meta: Record<string, unknown>;
}

export interface GenerateStructuredJsonError {
  ok: false;
  code: "LLM_STRUCTURED_OUTPUT_PARSE_FAILED" | "LLM_UNAVAILABLE" | "LLM_VALIDATION_FAILED";
  error: string;
  meta: Record<string, unknown>;
}

export type GenerateStructuredJsonResult<T> = GenerateStructuredJsonOk<T> | GenerateStructuredJsonError;

// ─── Helpers ────────────────────────────────────────────────────

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

function buildMeta(
  agentName: string,
  routeTier: RouteTier,
  modelConfig: { provider: string; model: string; baseUrl?: string; apiKeyPresent: boolean; agentKey: string },
  modelName: string,
  promptHash: string,
  retryCount: number,
  mode: string
): Record<string, unknown> {
  return {
    mode,
    model: modelName,
    route_tier: routeTier,
    agent_name: agentName,
    prompt_hash: promptHash,
    retry_count: retryCount,
    provider: modelConfig.provider,
    agent_key: modelConfig.agentKey,
    base_url_present: !!modelConfig.baseUrl,
    api_key_present: modelConfig.apiKeyPresent,
  };
}

/**
 * Extract JSON from various response formats:
 * - Direct content string
 * - Fenced JSON block (```json ... ```)
 * - Content array (some providers return [{type: "text", text: "..."}])
 * - reasoning_content with content (MiMo pattern)
 */
function extractJsonFromResponse(response: unknown): string | null {
  const msg = response as Record<string, unknown>;
  const content = msg?.content;

  // Handle content array (OpenAI-style)
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") {
        const json = tryExtractJson(part);
        if (json) return json;
      }
      if (typeof part === "object" && part !== null) {
        const textPart = part as Record<string, unknown>;
        if (typeof textPart.text === "string") {
          const json = tryExtractJson(textPart.text);
          if (json) return json;
        }
      }
    }
  }

  // Handle string content
  if (typeof content === "string" && content.trim()) {
    const json = tryExtractJson(content);
    if (json) return json;
  }

  // Handle MiMo reasoning_content pattern
  const additionalKwargs = msg?.additional_kwargs as Record<string, unknown> | undefined;
  const reasoningContent = additionalKwargs?.reasoning_content;
  if (typeof reasoningContent === "string" && reasoningContent.trim()) {
    // MiMo sometimes puts the actual response in reasoning_content
    // Try to extract from there, but only if main content is empty
    if (!content || (typeof content === "string" && !(content as string).trim())) {
      const json = tryExtractJson(reasoningContent);
      if (json) return json;
    }
  }

  // Handle lc_kwargs pattern (LangChain internal)
  const lcKwargs = msg?.lc_kwargs as Record<string, unknown> | undefined;
  const lcContent = lcKwargs?.content;
  if (typeof lcContent === "string" && lcContent.trim()) {
    const json = tryExtractJson(lcContent);
    if (json) return json;
  }

  return null;
}

/**
 * Try to extract a JSON object from a string.
 * Handles: raw JSON, fenced ```json blocks, embedded JSON objects.
 */
function tryExtractJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. Direct JSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      // Not valid JSON, continue
    }
  }

  // 2. Fenced JSON block
  const fencedMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fencedMatch) {
    const inner = fencedMatch[1].trim();
    if (inner.startsWith("{") || inner.startsWith("[")) {
      try {
        JSON.parse(inner);
        return inner;
      } catch {
        // Not valid JSON
      }
    }
  }

  // 3. Find first JSON object in text
  const firstBrace = trimmed.indexOf("{");
  if (firstBrace >= 0) {
    // Try progressively larger substrings
    for (let end = trimmed.length; end > firstBrace; end--) {
      const candidate = trimmed.slice(firstBrace, end);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
  }

  return null;
}

// ─── Providers that support native structured output ────────────

const NATIVE_STRUCTURED_PROVIDERS = new Set(["openai", "anthropic"]);

function supportsNativeStructured(provider: string): boolean {
  return NATIVE_STRUCTURED_PROVIDERS.has(provider.toLowerCase());
}

// ─── Main API ───────────────────────────────────────────────────

export async function generateStructuredJson<T>(
  input: GenerateStructuredJsonInput
): Promise<GenerateStructuredJsonResult<T>> {
  const { agentName, routeTier, systemPrompt, userPrompt, schema } = input;
  const required = isLlmRequired();

  const model = getTutorModel(agentName);
  const modelConfig = getTutorModelConfig(agentName);
  const modelName = getTutorModelName(agentName);
  const promptHash = hashPrompt(systemPrompt);

  if (!model) {
    const meta = buildMeta(agentName, routeTier, modelConfig, modelName, promptHash, 0, "llm_unavailable");
    if (required) {
      return { ok: false, code: "LLM_UNAVAILABLE", error: `No LLM model available for agent [${modelConfig.agentKey}]`, meta };
    }
    return { ok: false, code: "LLM_UNAVAILABLE", error: "No LLM model available (no API key)", meta };
  }

  const messages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt),
  ];

  const maxAttempts = 2;
  let lastError = "";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Strategy 1: Try native structured output for supported providers
    if (supportsNativeStructured(modelConfig.provider)) {
      try {
        const structuredModel = (model as ChatOpenAI).withStructuredOutput(schema);
        const result = await structuredModel.invoke(messages);
        const parsed = schema.safeParse(result);
        if (parsed.success) {
          const meta = buildMeta(agentName, routeTier, modelConfig, modelName, promptHash, attempt, "llm_structured_native");
          return { ok: true, data: parsed.data as T, meta };
        }
        lastError = `Native structured output Zod validation failed: ${parsed.error.issues.map(i => i.message).join("; ")}`;
      } catch (e: unknown) {
        lastError = `Native structured output failed: ${e instanceof Error ? e.message : String(e)}`;
        // Fall through to raw invoke
      }
    }

    // Strategy 2: Raw invoke + JSON extraction
    try {
      const result = await (model as ChatOpenAI).invoke(messages);
      const jsonStr = extractJsonFromResponse(result);

      // Debug: log response shape for provider debugging (no secrets)
      if (process.env.PAYLABS_LLM_DEBUG === "true") {
        const dbg = result as unknown as Record<string, unknown>;
        const dbgContent = dbg?.content;
        const dbgAk = dbg?.additional_kwargs as Record<string, unknown> | undefined;
        console.log("[llm-structured] response shape:", {
          content_type: typeof dbgContent,
          content_length: typeof dbgContent === "string" ? dbgContent.length : Array.isArray(dbgContent) ? dbgContent.length : "n/a",
          content_preview: typeof dbgContent === "string" ? dbgContent.slice(0, 200) : "non-string",
          has_reasoning: !!dbgAk?.reasoning_content,
          jsonStr_found: !!jsonStr,
          jsonStr_preview: jsonStr ? jsonStr.slice(0, 200) : "null",
        });
      }

      if (!jsonStr) {
        // Check for MiMo empty content + reasoning_content
        const msg = result as unknown as Record<string, unknown>;
        const content = msg?.content as string | unknown;
        const hasEmptyContent = !content || (typeof content === "string" && !content.trim());
        const ak = msg?.additional_kwargs as Record<string, unknown> | undefined;
        const hasReasoning = !!ak?.reasoning_content;

        if (hasEmptyContent && hasReasoning) {
          // MiMo returned reasoning but no parseable content
          lastError = "MiMo returned reasoning_content with empty content — no JSON extractable";
          // Don't retry — this is a provider limitation
          break;
        }

        lastError = "No JSON extractable from LLM response";
        if (attempt === 0) continue;
        break;
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(jsonStr);
      } catch (e: unknown) {
        lastError = `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`;
        if (attempt === 0) continue;
        break;
      }

      const parsed = schema.safeParse(parsedJson);
      if (!parsed.success) {
        lastError = `Zod validation failed: ${parsed.error.issues.map(i => i.message).join("; ")}`;
        if (process.env.PAYLABS_LLM_DEBUG === "true") {
          console.log("[llm-structured] parsed JSON (pre-validation):", JSON.stringify(parsedJson).slice(0, 500));
        }
        if (attempt === 0) continue;
        break;
      }

      const meta = buildMeta(agentName, routeTier, modelConfig, modelName, promptHash, attempt, "llm_structured_json_extract");
      return { ok: true, data: parsed.data as T, meta };

    } catch (e: unknown) {
      lastError = `LLM invoke failed: ${e instanceof Error ? e.message : String(e)}`;
      if (attempt === 0) continue;
      break;
    }
  }

  // All attempts failed
  const meta = buildMeta(agentName, routeTier, modelConfig, modelName, promptHash, maxAttempts, "llm_error");

  // Determine error code
  const code = lastError.includes("empty content") || lastError.includes("no JSON extractable")
    ? "LLM_STRUCTURED_OUTPUT_PARSE_FAILED"
    : "LLM_VALIDATION_FAILED";

  if (required) {
    // Throw for critical agents when LLM is required
    throw new Error(`PAYLABS_LLM_REQUIRED=true but ${agentName} failed after ${maxAttempts} attempts: ${lastError}`);
  }

  return { ok: false, code, error: `Failed after ${maxAttempts} attempts: ${lastError}`, meta };
}
