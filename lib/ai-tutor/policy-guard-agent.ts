/**
 * Agent 4: Policy Guard Agent
 * Gates every purchase before money can move.
 * No payment, no Runner — read-only validation.
 * Route tier is recorded but NEVER weakens policy checks.
 */

import type { PayLabsTutorStateType } from "./state";
import type { RouteTier } from "./route-config";
import { getPromptsForRoute } from "./route-prompts";
import { runPolicyChecks } from "./tools";
import { supabaseAdmin } from "@/lib/supabase/server";
import { createHash } from "node:crypto";

export async function policyGuardAgent(
  state: PayLabsTutorStateType
): Promise<Partial<PayLabsTutorStateType>> {
  const { userWallet, pathId, lessonId, routeTier, routePrompts } = state;
  const tier: RouteTier = routeTier || "normal";
  const prompts = (routePrompts as unknown as ReturnType<typeof getPromptsForRoute>) || getPromptsForRoute(tier);

  // Build prompt trace
  const promptText = prompts.policyGuard;
  const promptHash = createHash("sha256").update(promptText).digest("hex").slice(0, 16);

  if (!pathId) {
    return {
      policyDecision: { allowed: false, reason: "path_id is required", route_tier: tier },
      error: "Missing path_id",
    };
  }

  if (!lessonId) {
    return {
      policyDecision: { allowed: false, reason: "lesson_id is required", route_tier: tier },
      error: "Missing lesson_id",
    };
  }

  try {
    const decision = await runPolicyChecks(userWallet, pathId, lessonId);

    // Attach route_tier and prompt trace to decision — does NOT affect outcome
    const decisionWithTier = {
      ...decision,
      route_tier: tier,
      prompt_persona: `${tier}_policy_guard`,
      prompt_hash: promptHash,
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
      policyDecision: { allowed: false, reason: `Policy check error: ${msg}`, route_tier: tier },
      error: msg,
    };
  }
}
