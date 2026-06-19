/**
 * Agent 12: Policy Guard
 * LLM explains policy audit. Backend final allow/block is deterministic.
 */
import { z } from "zod";
import type { PayLabsTutorStateType } from "../state";
import { generateStructuredJson } from "../llm-structured";
import { runPolicyChecks } from "../tools";
import { supabaseAdmin } from "@/lib/supabase/server";
import { createHash } from "node:crypto";

const Schema = z.object({
  policy_summary: z.string(),
  risk_flags: z.array(z.string()),
});

const SYSTEM_PROMPT = `You are PayLabs Policy Guard Agent. Provide a policy audit explanation. Final allow/block is deterministic backend logic. You must be conservative. Payment must be blocked if: source path is not owned by user, source path is not approved/active, source path item is missing, feed item inactive, feed item not monetized, route not verified, route not monetized, creator wallet missing, wallet mismatch, price <= 0, duplicate completed payment exists, budget/route cap exceeded, payment executor unavailable. You cannot execute payment. You cannot override backend checks. You cannot create payment proof. Return structured JSON only.`;

export async function policyGuardAgent(state: PayLabsTutorStateType) {
  const { userWallet, sourcePathId, sourcePathItemId, routeTier } = state;
  const tier = routeTier || "normal";

  if (!sourcePathId || !sourcePathItemId) {
    return {
      policyDecision: { allowed: false, reason: "source_path_id and source_path_item_id required", route_tier: tier },
      error: "Missing source_path_id or source_path_item_id",
    };
  }

  // Deterministic policy checks — final decision
  let decision;
  try {
    decision = await runPolicyChecks(userWallet, sourcePathId, sourcePathItemId);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      policyDecision: { allowed: false, reason: `Policy check error: ${msg}`, route_tier: tier },
      error: msg,
    };
  }

  // LLM reasoning — NOT for final decision
  const result = await generateStructuredJson<z.infer<typeof Schema>>({
    agentName: "policy_guard",
    routeTier: tier,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Route: ${tier}\nUser wallet: ${userWallet}\nSource path: ${sourcePathId}\nItem: ${sourcePathItemId}\n\nDeterministic checks:\n${JSON.stringify(decision, null, 2)}\n\nProvide policy reasoning. Return structured JSON only.`,
    schema: Schema,
  });

  const decisionWithTier: Record<string, unknown> = {
    ...decision,
    route_tier: tier,
    ...(result.ok ? { llm_summary: result.data.policy_summary, llm_risk_flags: result.data.risk_flags } : {}),
  };

  // Log blocked actions
  if (!decision.allowed) {
    Promise.resolve(supabaseAdmin()
      .from("paylabs_agent_actions")
      .insert({
        user_wallet: userWallet.toLowerCase(),
        agent_id: "paylabs-langgraph-v1",
        action_type: "source_payment",
        agent_name: "policy_guard",
        route_tier: tier,
        input_hash: createHash("sha256").update(`${sourcePathItemId}:${userWallet}`).digest("hex"),
        output_hash: "",
        status: "blocked_by_policy",
        policy_decision: decisionWithTier,
      })
      .then(() => {})).catch(() => {});
  }

  return {
    policyDecision: decisionWithTier,
    agentTrace: { policy_guard: result.ok ? result.meta : { error: result.error } },
    ...(result.ok ? { llmOutputs: { policy_guard: result.data } } : { llmErrors: { policy_guard: result } }),
    agentCallCounts: { policy_guard: 1 },
  };
}
