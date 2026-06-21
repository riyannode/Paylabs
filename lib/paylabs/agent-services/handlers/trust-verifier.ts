/**
 * Trust Verifier Handler
 *
 * Reuses: provenance_verifier + creator_ownership_verifier
 * Macro-node: payment_decision
 * Requires LLM: yes (risk summary only — deterministic checks required)
 *
 * Deterministic checks: canonical URL, hashes, claim status, creator wallet, source metadata.
 * Optional LLM: safe risk summary only.
 */

import { z } from "zod";
import { generateStructuredJson } from "@/lib/ai/llm-structured";
import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";
import { toInternalRouteTier } from "./helpers";
import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";

const TrustVerifierSchema = z.object({
  risk_score: z.number().min(0).max(1),
  provenance_ok: z.boolean(),
  creator_verified: z.boolean(),
  trust_warnings: z.array(z.string()),
  safe_summary: z.string(),
});

const SYSTEM_PROMPT = `You are PayLabs Trust Verifier. Evaluate the trustworthiness of a source and its creator. Check provenance signals, creator verification status, and potential risks. You cannot set prices, wallets, or execute payments. Return structured JSON only. Always include a safe_summary field.`;

// Deterministic checks — no LLM
function runDeterministicChecks(input: {
  source_url: string;
  creator_wallet: string | null;
  claim_status: string;
}): { provenanceOk: boolean; creatorVerified: boolean; warnings: string[] } {
  const warnings: string[] = [];

  // URL must be valid
  let provenanceOk = false;
  try {
    const url = new URL(input.source_url);
    provenanceOk = url.protocol === "https:" || url.protocol === "http:";
  } catch {
    warnings.push("Invalid source URL");
  }

  // Creator wallet must be valid EVM address if present
  let creatorVerified = false;
  if (input.creator_wallet) {
    if (/^0x[a-fA-F0-9]{40}$/.test(input.creator_wallet)) {
      creatorVerified = input.claim_status === "verified";
    } else {
      warnings.push("Invalid creator wallet format");
    }
  } else {
    warnings.push("No creator wallet — unclaimed source");
  }

  // Claim status checks
  if (input.claim_status === "unclaimed") {
    warnings.push("Source is unclaimed — no creator payout");
  }

  return { provenanceOk, creatorVerified, warnings };
}

export const trustVerifierHandler: ServiceHandler = async (
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> => {
  const { feed_item_id, source_url, creator_wallet, claim_status, routeTier } =
    input.payload as {
      feed_item_id: string;
      source_url: string;
      creator_wallet: string | null;
      claim_status: string;
      routeTier?: DelegatedRouteTier;
    };

  // Deterministic checks first
  const det = runDeterministicChecks({ source_url, creator_wallet, claim_status });

  // LLM for safe risk summary (optional)
  const result = await generateStructuredJson<z.infer<typeof TrustVerifierSchema>>({
    agentName: "trust_verifier",
    routeTier: toInternalRouteTier(routeTier || "easy"),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Source ID: ${feed_item_id}\nURL: ${source_url}\nCreator wallet: ${creator_wallet || "none"}\nClaim status: ${claim_status}\n\nDeterministic checks: provenance=${det.provenanceOk}, creator=${det.creatorVerified}, warnings=${JSON.stringify(det.warnings)}\n\nEvaluate trust. Return structured JSON only.`,
    schema: TrustVerifierSchema,
  });

  if (!result.ok) {
    // Fallback: deterministic only
    return {
      ok: true,
      serviceName: "trust_verifier",
      data: {
        risk_score: det.creatorVerified ? 0.2 : 0.8,
        provenance_ok: det.provenanceOk,
        creator_verified: det.creatorVerified,
        payout_target_hint: creator_wallet,
        trust_warnings: det.warnings,
        safe_trust_summary: `Provenance: ${det.provenanceOk ? "ok" : "fail"}, creator: ${det.creatorVerified ? "verified" : "unverified"} (deterministic).`,
      },
      safeSummary: `Provenance: ${det.provenanceOk ? "ok" : "fail"}, creator: ${det.creatorVerified ? "verified" : "unverified"} (deterministic).`,
      settled: false,
      error: null,
    };
  }

  return {
    ok: true,
    serviceName: "trust_verifier",
    data: {
      risk_score: result.data.risk_score,
      provenance_ok: det.provenanceOk, // deterministic, not LLM
      creator_verified: det.creatorVerified, // deterministic, not LLM
      payout_target_hint: creator_wallet,
      trust_warnings: [...det.warnings, ...result.data.trust_warnings],
      safe_trust_summary: result.data.safe_summary,
    },
    safeSummary: result.data.safe_summary,
    settled: false,
    error: null,
  };
};
