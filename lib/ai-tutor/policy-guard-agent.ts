/**
 * Agent 4: Policy Guard Agent (LLM reasoning + deterministic decision)
 * Gates every source payment before money can move.
 * No payment, no Runner — read-only validation.
 *
 * LLM provides policy reasoning/explanation, but final allow/block
 * is deterministic from runPolicyChecks. LLM CANNOT override failed checks.
 */

import type { PayLabsTutorStateType } from "./state";
import type { RouteTier } from "./route-config";
import { getPromptsForRoute } from "./route-prompts";
import { invokeJsonAgent } from "./llm-json";
import { runPolicyChecks } from "./tools";
import { supabaseAdmin } from "@/lib/supabase/server";
import { createHash } from "node:crypto";
import { z } from "zod";

// ─── Zod schema for LLM structured output ───────────────────────

const PolicySchema = z.object({
  policy_summary: z.string().describe("Summary of the policy evaluation"),
  user_facing_reason: z.string().describe("User-friendly reason for the decision"),
  risk_flags: z.array(z.string()).describe("Any risk flags identified"),
});

type PolicyResult = z.infer<typeof PolicySchema>;

// ─── Main agent ─────────────────────────────────────────────────

export async function policyGuardAgent(
  state: PayLabsTutorStateType
): Promise<Partial<PayLabsTutorStateType>> {
  const { userWallet, sourcePathId, sourcePathItemId, routeTier, routePrompts } = state;
  const tier: RouteTier = routeTier || "normal";
  const prompts = (routePrompts as unknown as ReturnType<typeof getPromptsForRoute>) || getPromptsForRoute(tier);

  if (!sourcePathId) {
    return {
      policyDecision: { allowed: false, reason: "source_path_id is required", route_tier: tier },
      error: "Missing source_path_id",
    };
  }

  if (!sourcePathItemId) {
    return {
      policyDecision: { allowed: false, reason: "source_path_item_id is required", route_tier: tier },
      error: "Missing source_path_item_id",
    };
  }

  // ── DETERMINISTIC policy checks — final decision ──
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

  // Call LLM for reasoning — NOT for final decision
  const llmResult = await invokeJsonAgent<PolicyResult>({
    agentName: "policy_guard",
    routeTier: tier,
    prompt: prompts.policyGuard,
    userMessage: `Route tier: ${tier}\nUser wallet: ${userWallet}\nSource path ID: ${sourcePathId}\nSource path item ID: ${sourcePathItemId}\n\nDeterministic policy checks result:\n${JSON.stringify(decision, null, 2)}\n\nProvide policy reasoning and user-facing explanation.`,
    schema: PolicySchema,
  });

  // Build decision with LLM reasoning — but allowed is ALWAYS from deterministic checks
  let llmMeta: Record<string, unknown> = {};
  let llmPolicy: PolicyResult | undefined;

  if (llmResult.ok) {
    const okResult = llmResult as { ok: true; data: PolicyResult; meta: Record<string, unknown> };
    llmPolicy = okResult.data;
    llmMeta = okResult.meta;
  } else {
    const errResult = llmResult as { ok: false; error: string; meta: Record<string, unknown> };
    llmMeta = errResult.meta;
  }

  // Final decision: deterministic only — LLM CANNOT override
  const decisionWithTier = {
    ...decision,
    route_tier: tier,
    // LLM reasoning included for audit — does NOT affect allowed
    ...(llmPolicy ? {
      llm_summary: llmPolicy.policy_summary,
      llm_user_reason: llmPolicy.user_facing_reason,
      llm_risk_flags: llmPolicy.risk_flags,
    } : {}),
  };

  if (!decision.allowed) {
    Promise.resolve(supabaseAdmin()
      .from("paylabs_agent_actions")
      .insert({
        user_wallet: userWallet.toLowerCase(),
        agent_id: "paylabs-langgraph-v1",
        action_type: "source_payment",
        input_hash: createHash("sha256")
          .update(`${sourcePathItemId}:${userWallet}`)
          .digest("hex"),
        output_hash: "",
        status: "blocked_by_policy",
        policy_decision: decisionWithTier,
      })
      .then(() => {})).catch(() => {});
  }

  return {
    policyDecision: decisionWithTier as unknown as Record<string, unknown>,
    agentTrace: { policy_guard: llmMeta },
    ...(llmResult.ok ? { llmOutputs: { policy_guard: (llmResult as { data: unknown }).data } } : { llmErrors: { policy_guard: llmResult } }),
  };
}
