/**
 * PayLabs LLM JSON Agent Helper
 *
 * Shared helper for all 5 agents to call LLM with structured output.
 * - Calls actual model.invoke() with Zod schema
 * - Validates with zod
 * - Max 1 retry on invalid output
 * - Returns structured result or structured error
 * - Records model, route_tier, agent_name, prompt_persona, prompt_hash, mode, token usage
 * - No secrets printed
 */

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createHash } from "node:crypto";
import { getTutorModel, getTutorModelName } from "./llm";
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
  ok: boolean;
  data?: T;
  error?: string;
  meta: {
    mode: "llm";
    model: string;
    route_tier: RouteTier;
    agent_name: string;
    prompt_persona: string;
    prompt_hash: string;
    token_usage?: { input?: number; output?: number; total?: number };
    retry_count: number;
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
  };
}

// ─── Helper ─────────────────────────────────────────────────────

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

function extractTokenUsage(response: unknown): { input?: number; output?: number; total?: number } | undefined {
  try {
    const r = response as Record<string, unknown>;
    const usage = r?.usage as Record<string, number> | undefined;
    if (usage) {
      return {
        input: usage.input_tokens ?? usage.prompt_tokens,
        output: usage.output_tokens ?? usage.completion_tokens,
        total: usage.total_tokens,
      };
    }
  } catch { /* ignore */ }
  return undefined;
}

// ─── Main invoke ────────────────────────────────────────────────

export async function invokeJsonAgent<T = Record<string, unknown>>(
  input: InvokeJsonAgentInput
): Promise<LlmAgentResult<T> | LlmAgentError> {
  const { agentName, routeTier, prompt, userMessage, schema } = input;

  const model = getTutorModel();
  if (!model) {
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
      },
    };
  }

  const modelName = getTutorModelName();
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
        },
      };
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt === 0) continue; // retry once
      break;
    }
  }

  return {
    ok: false,
    error: `LLM call failed after ${maxAttempts} attempts: ${lastError}`,
    meta: {
      mode: "llm_error",
      model: modelName,
      route_tier: routeTier,
      agent_name: agentName,
      prompt_persona: persona,
      prompt_hash: promptHash,
      retry_count: maxAttempts,
    },
  };
}
