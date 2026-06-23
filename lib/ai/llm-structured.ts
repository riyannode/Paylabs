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
import { zodToJsonSchema } from "zod-to-json-schema";
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
  modelConfig: { provider: string; model: string; baseUrl?: string; apiKeyPresent: boolean; agentKey: string; timeoutMs: number; maxTokens: number },
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
    timeout_ms: modelConfig.timeoutMs,
    max_tokens: modelConfig.maxTokens,
  };
}

/**
 * Extract JSON from various response formats:
 * - Direct content string
 * - Fenced JSON block (\`\`\`json ... \`\`\`)
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
 * Handles: raw JSON, fenced \`\`\`json blocks, embedded JSON objects.
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

const NATIVE_STRUCTURED_PROVIDERS = new Set(["openai", "anthropic", "mimo"]);

function supportsNativeStructured(provider: string): boolean {
  return NATIVE_STRUCTURED_PROVIDERS.has(provider.toLowerCase());
}

/**
 * Extract expected top-level keys from a Zod schema for instruction hints.
 */
function getExpectedKeys(schema: z.ZodType<unknown>): string[] {
  try {
    const jsonSchema = zodToJsonSchema(schema, { target: "openApi3" });
    const schemaObj = (jsonSchema as Record<string, unknown>)?.schema as Record<string, unknown> || jsonSchema;
    const props = schemaObj?.properties as Record<string, unknown> | undefined;
    if (props) return Object.keys(props);
  } catch {
    // Fallback — try Zod shape
  }
  try {
    const shape = (schema as unknown as { _def?: { shape?: () => Record<string, unknown> } })._def?.shape?.();
    if (shape) return Object.keys(shape);
  } catch {
    // ignore
  }
  return [];
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

  // Env-configurable max attempts per agent
  const rawMaxAttempts = Number(
    process.env[`PAYLABS_LLM_MAX_ATTEMPTS_${modelConfig.agentKey}`] ??
    process.env.PAYLABS_LLM_MAX_ATTEMPTS_DEFAULT ??
    process.env.PAYLABS_LLM_MAX_ATTEMPTS ??
    1
  );
  const maxAttempts = Math.max(1, Math.min(rawMaxAttempts || 1, 3));

  // Timeout retry behavior: skip for MiMo unless explicitly enabled
  const retryTimeouts = process.env.PAYLABS_LLM_RETRY_TIMEOUTS === "true";
  const isTimeoutProvider = modelConfig.provider === "mimo";

  const messages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt),
  ];

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

    // Strategy 2: Raw invoke + JSON extraction (with schema-in-prompt for non-native providers)
    try {
      // For non-native providers (MiMo, etc.), append JSON schema to system prompt
      const strategyMessages: BaseMessage[] = [...messages];
      if (!supportsNativeStructured(modelConfig.provider)) {
        try {
          const jsonSchema = zodToJsonSchema(schema, { target: "openApi3" });
          const schemaObj = (jsonSchema as Record<string, unknown>)?.schema as Record<string, unknown> || jsonSchema;
          const schemaStr = JSON.stringify(schemaObj, null, 2);
          const expectedKeys = getExpectedKeys(schema);
          const keyHint = expectedKeys.length > 0
            ? `\nRequired top-level keys: ${expectedKeys.join(", ")}`
            : "";
          const enhancedSystemPrompt = systemPrompt
            + "\n\nYou MUST respond with valid JSON matching this exact schema:\n```json\n" + schemaStr + "\n```\n"
            + "Return exactly one JSON object."
            + keyHint
            + "\nDo not use synonyms."
            + "\nDo not add markdown."
            + "\nDo not add explanation."
            + "\nDo not include fields outside the schema."
            + "\nReturn ONLY the JSON object, no other text.";
          strategyMessages[0] = new SystemMessage(enhancedSystemPrompt);
        } catch {
          // Schema conversion failed — proceed with original prompt
        }
      }

      const result = await (model as ChatOpenAI).invoke(strategyMessages);
      const jsonStr = extractJsonFromResponse(result);

      // Safe debug: no content preview, no full prompt, no secrets
      if (process.env.PAYLABS_LLM_DEBUG === "true") {
        const dbg = result as unknown as Record<string, unknown>;
        const dbgContent = dbg?.content;
        const dbgAk = dbg?.additional_kwargs as Record<string, unknown> | undefined;
        const expectedKeys = getExpectedKeys(schema);
        let receivedKeys: string[] = [];
        if (jsonStr) {
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              receivedKeys = Object.keys(parsed);
            }
          } catch { /* ignore */ }
        }
        console.log("[llm-structured] response:", {
          provider: modelConfig.provider,
          model: modelName,
          agent_name: agentName,
          mode: "llm_structured_json_extract",
          attempt,
          expected_keys: expectedKeys,
          received_keys: receivedKeys,
          content_length: typeof dbgContent === "string" ? dbgContent.length : Array.isArray(dbgContent) ? dbgContent.length : "n/a",
          has_reasoning: !!dbgAk?.reasoning_content,
          json_found: !!jsonStr,
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
          // Log for debugging MiMo response structure
          console.log("[llm-structured] MiMo empty content + reasoning_content detected", {
            agent: agentName,
            reasoning_type: typeof ak?.reasoning_content,
            reasoning_length: typeof ak?.reasoning_content === "string" ? (ak.reasoning_content as string).length : 0,
            reasoning_preview: typeof ak?.reasoning_content === "string" ? (ak.reasoning_content as string).substring(0, 200) : "not-string",
            msg_keys: Object.keys(msg || {}),
            ak_keys: Object.keys(ak || {}),
          });
          lastError = "MiMo returned reasoning_content with empty content — no JSON extractable";
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
        const issuePaths = parsed.error.issues.map(i => i.path.join("."));
        lastError = `Zod validation failed: ${parsed.error.issues.map(i => i.message).join("; ")}`;
        if (process.env.PAYLABS_LLM_DEBUG === "true") {
          console.log("[llm-structured] validation:", {
            provider: modelConfig.provider,
            model: modelName,
            agent_name: agentName,
            attempt,
            validation_issue_paths: issuePaths,
            content_length: jsonStr.length,
          });
        }
        if (attempt === 0) continue;
        break;
      }

      const meta = buildMeta(agentName, routeTier, modelConfig, modelName, promptHash, attempt, "llm_structured_json_extract");
      return { ok: true, data: parsed.data as T, meta };

    } catch (e: unknown) {
      lastError = `LLM invoke failed: ${e instanceof Error ? e.message : String(e)}`;

      // Timeout retry skip: MiMo timeouts should not retry unless explicitly enabled
      const isTimeout = isTimeoutProvider && (
        lastError.includes("timeout") || lastError.includes("timed out") || lastError.includes("Request timed out")
      );
      if (isTimeout && !retryTimeouts) {
        break;
      }

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
