// POST /api/paylabs/agent-capabilities/tutor-intake
//
// Paid agent capability: normalize_goal
// Agent 1 of 7 in the nanopayment audit lane.
// Validates 3 request headers, returns 3 response headers.

import { NextRequest } from "next/server";
import {
  validateAgentRequest,
  buildAgentResponse,
  buildAgentError,
  recordAgentCapabilityResult,
} from "@/lib/paylabs/agent-capability-helpers";

const AGENT_NAME = "tutor_intake" as const;

export async function POST(req: NextRequest) {
  const validation = validateAgentRequest(req, AGENT_NAME);
  if (!validation.valid) {
    return buildAgentError(validation.error, validation.status);
  }

  const { context } = validation;

  try {
    // Capability: normalize_goal
    // In PR #15, this is a skeleton that records the call.
    // Real LLM integration will wire into the existing tutor-intake-agent.
    const result = { ok: true, capability: "normalize_goal", agent: AGENT_NAME };

    await recordAgentCapabilityResult(context, result);

    return buildAgentResponse({
      status: "completed",
      agent_name: AGENT_NAME,
      capability: "normalize_goal",
      receipt_id: context.receipt_id,
      receipt_url: context.receipt_url,
      amount_usdc: context.amount_usdc,
      settlement_mode: context.settlement_mode,
    }, context);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordAgentCapabilityResult(context, { ok: false, error: msg });
    return buildAgentError(`Agent capability failed: ${msg}`, 500);
  }
}
