// POST /api/paylabs/agent-capabilities/attribution-auditor
//
// Paid agent capability: audit_attribution
// Agent 7 of 7 in the nanopayment audit lane.

import { NextRequest } from "next/server";
import {
  validateAgentRequest,
  buildAgentResponse,
  buildAgentError,
  recordAgentCapabilityResult,
} from "@/lib/paylabs/agent-capability-helpers";

const AGENT_NAME = "attribution_auditor" as const;

export async function POST(req: NextRequest) {
  const validation = validateAgentRequest(req, AGENT_NAME);
  if (!validation.valid) {
    return buildAgentError(validation.error, validation.status);
  }

  const { context } = validation;

  try {
    const result = { ok: true, capability: "audit_attribution", agent: AGENT_NAME };
    await recordAgentCapabilityResult(context, result);

    return buildAgentResponse({
      status: "completed",
      agent_name: AGENT_NAME,
      capability: "audit_attribution",
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
