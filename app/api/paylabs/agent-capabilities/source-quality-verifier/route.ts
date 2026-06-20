// POST /api/paylabs/agent-capabilities/source-quality-verifier
//
// Compatibility adapter for the source_quality_verifier paid agent.
// Validates HMAC-signed context but does NOT execute the agent.
// Real execution happens via the unified LangGraph pipeline:
//   POST /api/paylabs/discovery-runs/pay
//
// Returns the actual nanopayment row status from DB.

import { NextRequest } from "next/server";
import {
  validateAgentRequest,
  buildAgentResponse,
  buildAgentError,
  getAgentCapabilityStatus,
} from "@/lib/paylabs/agent-capability-helpers";

const AGENT_NAME = "source_quality_verifier" as const;

export async function POST(req: NextRequest) {
  const validation = validateAgentRequest(req, AGENT_NAME);
  if (!validation.valid) {
    return buildAgentError(validation.error, validation.status);
  }

  const { context } = validation;

  try {
    // Look up actual status from DB — never return fake ok:true
    const status = await getAgentCapabilityStatus(context);

    return buildAgentResponse({
      adapter: true,
      message: "This is a compatibility endpoint. Real execution via unified pipeline.",
      execution_path: "POST /api/paylabs/discovery-runs/pay",
      agent_name: AGENT_NAME,
      capability: "verify_source_quality",
      receipt_id: context.receipt_id,
      receipt_url: context.receipt_url,
      amount_usdc: context.amount_usdc,
      db_status: status.status,
    }, context);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildAgentError(`Adapter error: ${msg}`, 500);
  }
}
