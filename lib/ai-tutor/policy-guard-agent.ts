/**
 * Agent 4: Policy Guard Agent
 * Gates every purchase before money can move.
 * No payment, no Runner — read-only validation.
 * Route tier is recorded but NEVER weakens policy checks.
 */

import type { PayLabsTutorStateType } from "./state";
import { runPolicyChecks } from "./tools";
import { supabaseAdmin } from "@/lib/supabase/server";
import { createHash } from "node:crypto";

export async function policyGuardAgent(
  state: PayLabsTutorStateType
): Promise<Partial<PayLabsTutorStateType>> {
  const { userWallet, pathId, lessonId, routeTier } = state;

  if (!pathId) {
    return {
      policyDecision: { allowed: false, reason: "path_id is required", route_tier: routeTier || "normal" },
      error: "Missing path_id",
    };
  }

  if (!lessonId) {
    return {
      policyDecision: { allowed: false, reason: "lesson_id is required", route_tier: routeTier || "normal" },
      error: "Missing lesson_id",
    };
  }

  try {
    const decision = await runPolicyChecks(userWallet, pathId, lessonId);

    // Attach route_tier to decision — does NOT affect outcome
    const decisionWithTier = {
      ...decision,
      route_tier: routeTier || "normal",
    };

    if (!decision.allowed) {
      // Log blocked action
      Promise.resolve(supabaseAdmin()
        .from("paylabs_agent_actions")
        .insert({
          user_wallet: userWallet.toLowerCase(),
          agent_id: "paylabs-langgraph-v1",
          action_type: "buy_lesson",
          input_hash: createHash("sha256")
            .update(`${lessonId}:${userWallet}`)
            .digest("hex"),
          output_hash: "",
          status: "blocked_by_policy",
          policy_decision: decisionWithTier,
        })
        .then(() => {})).catch(() => {});
    }

    return { policyDecision: decisionWithTier as unknown as Record<string, unknown> };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      policyDecision: { allowed: false, reason: `Policy check error: ${msg}`, route_tier: routeTier || "normal" },
      error: msg,
    };
  }
}
