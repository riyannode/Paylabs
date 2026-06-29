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
  modelConfig: { provider: string; model: string; baseUrl?: string; apiKeyPresent: boolean; agentKey: string; timeoutMs: number; maxTokens: number; streaming?: boolean; forceNonStreamingBody?: boolean },
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
    streaming: modelConfig.streaming ?? null,
    force_non_streaming_body: modelConfig.forceNonStreamingBody ?? null,
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
  let lastDiag: Record<string, unknown> = {};

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

      // Safe diagnostics for brain_planner (gated — no raw output, no secrets)
      if (agentName === "brain_planner" && process.env.NODE_ENV !== "production") {
        const msg = result as unknown as Record<string, unknown>;
        const content = msg?.content as string | unknown;
        const expectedKeys = getExpectedKeys(schema);
        let receivedKeys: string[] = [];
        if (jsonStr) {
          try {
            const p = JSON.parse(jsonStr);
            if (p && typeof p === "object" && !Array.isArray(p)) receivedKeys = Object.keys(p);
          } catch { /* ignore */ }
        }
        console.log("[llm-structured] brain_planner invoke result:", {
          provider: modelConfig.provider,
          model: modelName,
          attempt,
          content_type: typeof content,
          content_length: typeof content === "string" ? content.length : "n/a",
          json_found: !!jsonStr,
          expected_keys: expectedKeys,
          received_keys: receivedKeys,
        });
        lastDiag = {
          ...lastDiag,
          json_found: !!jsonStr,
          content_type: typeof content,
          content_length: typeof content === "string" ? content.length : null,
          received_keys: receivedKeys,
          expected_keys: expectedKeys,
        };
      }

      if (!jsonStr) {
        // Check for MiMo empty content + reasoning_content
        const msg = result as unknown as Record<string, unknown>;
        const content = msg?.content as string | unknown;
        const hasEmptyContent = !content || (typeof content === "string" && !content.trim());
        const ak = msg?.additional_kwargs as Record<string, unknown> | undefined;
        const hasReasoning = !!ak?.reasoning_content;

        if (hasEmptyContent && hasReasoning) {
          // Safe diagnostics: no raw reasoning_content
          console.log("[llm-structured] MiMo empty content + reasoning_content detected", {
            agent: agentName,
            reasoning_type: typeof ak?.reasoning_content,
            reasoning_length: typeof ak?.reasoning_content === "string" ? (ak.reasoning_content as string).length : 0,
            provider: modelConfig.provider,
            model: modelName,
            mode: "llm_structured_json_extract",
            content_length: typeof content === "string" ? content.length : "n/a",
            json_found: false,
          });
          lastDiag = { ...lastDiag, json_found: false, parse_ok: false, error_code: "MIMO_EMPTY_CONTENT" };
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
        const expectedKeys = getExpectedKeys(schema);
        let receivedKeys: string[] = [];
        try {
          if (parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
            receivedKeys = Object.keys(parsedJson);
          }
        } catch { /* ignore */ }

        // Safe validation diagnostics (gated — no raw response, no secrets)
        if (process.env.NODE_ENV !== "production") {
          console.log("[llm-structured] Zod validation failed:", {
            provider: modelConfig.provider,
            model: modelName,
            agent_name: agentName,
            attempt,
            max_tokens: modelConfig.maxTokens,
            timeout_ms: modelConfig.timeoutMs,
            streaming: modelConfig.streaming,
            mode: "llm_structured_json_extract",
            json_found: true,
            received_keys: receivedKeys,
            expected_keys: expectedKeys,
            validation_issue_paths: issuePaths,
            content_length: jsonStr.length,
          });
        }
        lastDiag = {
          ...lastDiag,
          json_found: true,
          parse_ok: true,
          validation_ok: false,
          validation_issue_paths: issuePaths,
          received_keys: receivedKeys,
          expected_keys: expectedKeys,
          content_length: jsonStr.length,
        };

        // ── Repair attempt: ask model to fix the JSON for the failing paths ──
        if (attempt === 0) {
          try {
            const repairSystemPrompt = "You must return valid JSON matching the schema exactly. Fix the validation errors below. Return ONLY the corrected JSON object. No markdown. No commentary. No extra keys.";
            const repairUserPrompt = `The previous JSON response failed Zod validation.\n\nReceived keys: ${JSON.stringify(receivedKeys)}\nExpected keys: ${JSON.stringify(expectedKeys)}\nValidation errors: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}\n\nReturn the corrected JSON matching the schema exactly. Do not omit any required fields. Do not add fields outside the schema.`;
            const repairMessages: BaseMessage[] = [
              new SystemMessage(repairSystemPrompt),
              new HumanMessage(repairUserPrompt),
            ];

            const repairResult = await (model as ChatOpenAI).invoke(repairMessages);
            const repairJsonStr = extractJsonFromResponse(repairResult);

            if (repairJsonStr) {
              const repairParsed = schema.safeParse(JSON.parse(repairJsonStr));
              if (repairParsed.success) {
                console.log("[llm-structured] repair succeeded", {
                  agent_name: agentName,
                  provider: modelConfig.provider,
                  model: modelName,
                  attempt: attempt + 1,
                });
                const meta = buildMeta(agentName, routeTier, modelConfig, modelName, promptHash, attempt + 1, "llm_structured_repair");
                return { ok: true, data: repairParsed.data as T, meta };
              }
              console.log("[llm-structured] repair also failed Zod", {
                agent_name: agentName,
                repair_issue_paths: repairParsed.error.issues.map(i => i.path.join(".")),
              });
            } else {
              console.log("[llm-structured] repair: no JSON extractable", {
                agent_name: agentName,
              });
            }
          } catch (repairErr: unknown) {
            console.log("[llm-structured] repair attempt error:", {
              agent_name: agentName,
              error: repairErr instanceof Error ? repairErr.message.slice(0, 100) : String(repairErr).slice(0, 100),
            });
          }
        }

        lastError = `Zod validation failed: ${parsed.error.issues.map(i => i.message).join("; ")}`;
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

  // Merge lastDiag into meta for diagnostic propagation
  const metaWithDiag = { ...meta, ...lastDiag, error_code: code, error_safe: lastError.slice(0, 220) };

  if (required) {
    if (agentName !== "brain_planner") {
      // Throw for non-brain LLM-required agents (preserve existing behavior)
      throw new Error(`PAYLABS_LLM_REQUIRED=true but ${agentName} failed after ${maxAttempts} attempts: ${lastError}`);
    }
    // brain_planner: return ok:false with meta so caller gets diagnostics
    return { ok: false, code, error: `Failed after ${maxAttempts} attempts: ${lastError}`, meta: metaWithDiag };
  }

  return { ok: false, code, error: `Failed after ${maxAttempts} attempts: ${lastError}`, meta: metaWithDiag };
}
