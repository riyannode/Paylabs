/**
 * PayLabs LLM JSON Agent Helper
 *
 * Shared helper for all agents to call LLM with structured output.
 * Delegates to generateStructuredJson() from llm-structured.ts
 * which handles provider-safe JSON extraction.
 *
 * - No direct withStructuredOutput() in agent files
 * - Validates with Zod
 * - Returns structured result or structured error
 * - If PAYLABS_LLM_REQUIRED=true and LLM fails, THROWS (no silent bypass)
 * - Per-agent LLM config: provider, model, base_url_present, agent_key
 * - No secrets printed
 */

import { z } from "zod";
import { generateStructuredJson, type GenerateStructuredJsonResult } from "./llm-structured";
import type { RouteTier } from "./route-config";

// ─── Types ──────────────────────────────────────────────────────

export interface InvokeJsonAgentInput {
  agentName: string;
  routeTier: RouteTier;
  prompt: string;
  userMessage: string;
  schema: z.ZodType<unknown>;
}

export interface LlmAgentResult<T = Record<string, unknown>> {
  ok: true;
  data: T;
  meta: Record<string, unknown>;
}

export interface LlmAgentError {
  ok: false;
  error: string;
  meta: Record<string, unknown>;
}

// ─── Main invoke ────────────────────────────────────────────────

/**
 * Invoke an LLM agent with structured JSON output.
 * Delegates to generateStructuredJson() which handles:
 * - Native structured output for supported providers
 * - Fallback to raw invoke + JSON extraction
 * - MiMo reasoning_content handling
 * - Zod validation
 */
export async function invokeJsonAgent<T = Record<string, unknown>>(
  input: InvokeJsonAgentInput
): Promise<LlmAgentResult<T> | LlmAgentError> {
  const { agentName, routeTier, prompt, userMessage, schema } = input;

  const result: GenerateStructuredJsonResult<T> = await generateStructuredJson<T>({
    agentName,
    routeTier,
    systemPrompt: prompt,
    userPrompt: userMessage,
    schema,
  });

  if (result.ok) {
    return {
      ok: true,
      data: result.data,
      meta: result.meta,
    };
  }

  // Convert GenerateStructuredJsonError to LlmAgentError
  return {
    ok: false,
    error: result.error,
    meta: result.meta,
  };
}
