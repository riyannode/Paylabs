/**
 * Brain Planner Structured Test Endpoint
 *
 * Tests generateStructuredJson() with the actual BrainPlanningSchema.
 * No raw model response, no secrets, no prompt dumps in response.
 *
 * Gated: only available in non-production or with internal auth.
 * Remove after verification.
 */
import { NextResponse } from "next/server";

export const maxDuration = 30;

export async function GET() {
  try {
    // Gate: not for production
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ ok: false, error: "Disabled in production" }, { status: 404 });
    }

    const { getTutorModel, getTutorModelConfig, getTutorModelName, isLlmRequired } = await import("@/lib/ai/llm");
    const { generateStructuredJson } = await import("@/lib/ai/llm-structured");

    const agentName = "brain_planner";
    const modelConfig = getTutorModelConfig(agentName);
    const modelName = getTutorModelName(agentName);
    const model = getTutorModel(agentName);

    // Safe runtime diagnostics (no secrets)
    const NATIVE_STRUCTURED_PROVIDERS = new Set(["openai", "anthropic", "mimo"]);
    const supportsNative = NATIVE_STRUCTURED_PROVIDERS.has(modelConfig.provider.toLowerCase());
    const structuredMode = supportsNative ? "llm_structured_native" : "llm_structured_json_extract";

    const runtimeConfig: Record<string, unknown> = {
      provider: modelConfig.provider,
      model: modelName,
      agentKey: modelConfig.agentKey,
      baseUrlPresent: !!modelConfig.baseUrl,
      baseUrlHost: modelConfig.baseUrl ? new URL(modelConfig.baseUrl).host : null,
      apiKeyPresent: modelConfig.apiKeyPresent,
      streaming: modelConfig.streaming,
      maxTokens: modelConfig.maxTokens,
      timeoutMs: modelConfig.timeoutMs,
      llmRequired: isLlmRequired(),
      modelAvailable: !!model,
      supportsNativeStructured: supportsNative,
      structuredMode,
    };

    if (!model) {
      return NextResponse.json({ ok: false, error: "No LLM model", runtimeConfig }, { status: 500 });
    }

    // ── Import BrainPlanningSchema from the brain planner graph ──
    const { z } = await import("zod");
    const BrainPlanningSchema = z.object({
      normalized_goal: z.string(),
      route_tier_hint: z.enum(["easy", "normal", "advanced"]),
      discovery_strategy: z.string(),
      suggested_query_variants: z.array(z.string()),
      service_execution_plan: z.array(z.string()),
      safe_brain_summary: z.string(),
      assistant_response: z.string(),
      user_visible_reasoning: z.string(),
      tier_decision_reason: z.string(),
      plan_rationale: z.string(),
      selected_macro_nodes: z.array(z.enum(["discovery_planner", "payment_decision", "settlement_memory"])),
      selected_services: z.array(z.string()),
      max_registry_checks: z.number().int().min(0).max(50),
      max_source_accesses: z.number().int().min(0).max(50),
    });

    // ── Run generateStructuredJson with real BrainPlanningSchema ──
    const testPrompt = "valid ga klaim AWS WAF memakai x402 untuk AI bot monetization";

    const result = await generateStructuredJson({
      agentName: "brain_planner",
      routeTier: "normal",
      systemPrompt: `You are PayLabs Brain — a planning intelligence. Analyze the user goal and return structured JSON.

Return JSON only. No markdown. No commentary. No extra keys. The first character must be "{".

Return exactly this JSON shape:
{
  "normalized_goal": "string",
  "route_tier_hint": "easy",
  "discovery_strategy": "string",
  "suggested_query_variants": ["string"],
  "service_execution_plan": ["intent_planner", "query_builder", "signal_scout"],
  "safe_brain_summary": "string",
  "assistant_response": "string",
  "user_visible_reasoning": "string",
  "tier_decision_reason": "string",
  "plan_rationale": "string",
  "selected_macro_nodes": ["discovery_planner"],
  "selected_services": ["intent_planner", "query_builder", "signal_scout"],
  "max_registry_checks": 1,
  "max_source_accesses": 1
}`,
      userPrompt: `User goal: "${testPrompt}"
Budget: 0.01 USDC
Route tier: auto
Discovery run: brain-test-0001

Analyze this goal and produce a structured execution plan.`,
      schema: BrainPlanningSchema,
    });

    // ── Safe diagnostics only — no raw response, no raw model output ──
    const expectedKeys = [
      "normalized_goal", "route_tier_hint", "discovery_strategy",
      "suggested_query_variants", "service_execution_plan",
      "safe_brain_summary", "assistant_response", "user_visible_reasoning",
      "tier_decision_reason", "plan_rationale", "selected_macro_nodes",
      "selected_services", "max_registry_checks", "max_source_accesses",
    ];

    const data = result.ok ? result.data as Record<string, unknown> : null;

    return NextResponse.json({
      ok: result.ok,
      runtimeConfig,
      brainPlanningExists: !!data,
      route_tier_hint: data?.route_tier_hint ?? null,
      suggested_query_variants_count: Array.isArray(data?.suggested_query_variants) ? (data.suggested_query_variants as string[]).length : 0,
      selected_macro_nodes: data?.selected_macro_nodes ?? null,
      expected_keys: expectedKeys,
      received_keys: data ? Object.keys(data) : [],
      validation_issue_paths: !result.ok && result.meta?.validation_issue_paths ? result.meta.validation_issue_paths : [],
      error_code: result.ok ? null : result.code,
      error: result.ok ? null : result.error?.slice(0, 200) ?? null,
      meta: result.meta,
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    }, { status: 500 });
  }
}
