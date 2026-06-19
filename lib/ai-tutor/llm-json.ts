/**
 * PayLabs LLM JSON Agent Helper
 *
 * Shared helper for all agents to call LLM with structured output.
 * - Calls actual model.invoke() with Zod schema
 * - Validates with zod
 * - Max 1 retry on invalid output
 * - Returns structured result or structured error
 * - If PAYLABS_LLM_REQUIRED=true and LLM fails, THROWS (no silent bypass)
 * - Records model, route_tier, agent_name, prompt_persona, prompt_hash, mode
 * - Per-agent LLM config: provider, model, base_url_present, agent_key
 * - No secrets printed
 */

import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createHash } from "node:crypto";
import { getTutorModel, getTutorModelName, getTutorModelConfig, isLlmRequired } from "./llm";
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
  meta: {
    mode: "llm";
    model: string;
    route_tier: RouteTier;
    agent_name: string;
    prompt_persona: string;
    prompt_hash: string;
    retry_count: number;
    provider: string;
    agent_key: string;
    base_url_present: boolean;
    api_key_present: boolean;
  };
}

export interface LlmAgentError {
  ok: false;
  error: string;
  meta: {
    mode: "llm_error";
    model: string;
    route_tier: RouteTier;
    agent_name: string;
    prompt_persona: string;
    prompt_hash: string;
    retry_count: number;
    provider: string;
    agent_key: string;
    base_url_present: boolean;
    api_key_present: boolean;
  };
}

// ─── Helper ─────────────────────────────────────────────────────

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

// ─── Main invoke ────────────────────────────────────────────────

export async function invokeJsonAgent<T = Record<string, unknown>>(
  input: InvokeJsonAgentInput
): Promise<LlmAgentResult<T> | LlmAgentError> {
  const { agentName, routeTier, prompt, userMessage, schema } = input;
  const required = isLlmRequired();

  const model = getTutorModel(agentName);
  const modelConfig = getTutorModelConfig(agentName);
  const modelName = getTutorModelName(agentName);

  if (!model) {
    // No model available — this path only reached if NOT required
    // (getTutorModel throws if required + no key)
    return {
      ok: false,
      error: "No LLM model available (no API key)",
      meta: {
        mode: "llm_error",
        model: "none",
        route_tier: routeTier,
        agent_name: agentName,
        prompt_persona: `${routeTier}_${agentName}`,
        prompt_hash: hashPrompt(prompt),
        retry_count: 0,
        provider: modelConfig.provider,
        agent_key: modelConfig.agentKey,
        base_url_present: !!modelConfig.baseUrl,
        api_key_present: modelConfig.apiKeyPresent,
      },
    };
  }

  const promptHash = hashPrompt(prompt);
  const persona = `${routeTier}_${agentName}`;

  const messages: BaseMessage[] = [
    new SystemMessage(prompt),
    new HumanMessage(userMessage),
  ];

  let lastError: string = "";
  const maxAttempts = 2; // 1 attempt + 1 retry

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const structuredModel = model.withStructuredOutput(schema);
      const result = await structuredModel.invoke(messages);
      const typedResult = result as T;

      // Validate with zod
      const parsed = schema.safeParse(typedResult);
      if (!parsed.success) {
        lastError = `Zod validation failed: ${parsed.error.issues.map(i => i.message).join("; ")}`;
        if (attempt === 0) continue; // retry once
        break;
      }

      return {
        ok: true,
        data: parsed.data as T,
        meta: {
          mode: "llm",
          model: modelName,
          route_tier: routeTier,
          agent_name: agentName,
          prompt_persona: persona,
          prompt_hash: promptHash,
          retry_count: attempt,
          provider: modelConfig.provider,
          agent_key: modelConfig.agentKey,
          base_url_present: !!modelConfig.baseUrl,
          api_key_present: modelConfig.apiKeyPresent,
        },
      };
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt === 0) continue; // retry once
      break;
    }
  }

  // LLM failed after retries
  const errorMsg = `LLM call failed after ${maxAttempts} attempts: ${lastError}`;

  // If LLM is required, throw — do NOT allow silent bypass
  if (required) {
    throw new Error(
      `PAYLABS_LLM_REQUIRED=true but ${agentName} agent LLM failed: ${errorMsg}`
    );
  }

  return {
    ok: false,
    error: errorMsg,
    meta: {
      mode: "llm_error",
      model: modelName,
      route_tier: routeTier,
      agent_name: agentName,
      prompt_persona: persona,
      prompt_hash: promptHash,
      retry_count: maxAttempts,
      provider: modelConfig.provider,
      agent_key: modelConfig.agentKey,
      base_url_present: !!modelConfig.baseUrl,
      api_key_present: modelConfig.apiKeyPresent,
    },
  };
}
