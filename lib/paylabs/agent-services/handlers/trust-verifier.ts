/**
 * Trust Verifier Handler
 *
 * Reuses: provenance_verifier + creator_ownership_verifier
 * Macro-node: payment_decision
 *
 * Execution modes:
 *   - deterministic (default): URL/wallet/claim checks only, no LLM
 *   - hybrid: deterministic checks + LLM for safe risk summary
 *   - llm: LLM may assist risk evaluation, deterministic checks are source of truth
 *
 * Deterministic checks (source of truth in ALL modes):
 *   - URL validity (https/http)
 *   - Creator wallet format (EVM address)
 *   - Claim status (verified/unclaimed)
 *   - Provenance signals
 *
 * LLM only for safe risk summary/explanation (never for trust decisions).
 */

import { z } from "zod";
import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";
import {
  shouldRunServiceAsDeterministic,
  shouldRunServiceAsHybrid,
} from "../execution-mode";
import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";

const TrustVerifierSchema = z.object({
  risk_score: z.number().min(0).max(1),
  provenance_ok: z.boolean(),
  creator_verified: z.boolean(),
  trust_warnings: z.array(z.string()),
  safe_summary: z.string(),
});

const SYSTEM_PROMPT = `You are PayLabs Trust Verifier. Evaluate the trustworthiness of a source and its creator. Check provenance signals, creator verification status, and potential risks. You cannot set prices, wallets, or execute payments. Return structured JSON only. Always include a safe_summary field.`;

// ─── Deterministic Checks ───────────────────────────────────

function runDeterministicChecks(input: {
  source_url: string;
  creator_wallet: string | null;
  claim_status: string;
}): { provenanceOk: boolean; creatorVerified: boolean; riskScore: number; warnings: string[] } {
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

  // Deterministic risk score
  let riskScore = 0.5; // baseline
  if (!provenanceOk) riskScore = 0.9;
  else if (!creatorVerified) riskScore = 0.6;
  else if (input.claim_status === "verified") riskScore = 0.1;

  return { provenanceOk, creatorVerified, riskScore, warnings };
}

// ─── Handler ────────────────────────────────────────────────

export const trustVerifierHandler: ServiceHandler = async (
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> => {
  const routeTier = (input.payload as { routeTier?: DelegatedRouteTier }).routeTier;

  // ── Batch mode: payload.candidates is an array ──
  const candidates = (input.payload as {
    candidates?: Array<{ feed_item_id: string; source_url: string; creator_wallet: string | null; claim_status: string }>
  }).candidates;

  if (Array.isArray(candidates)) {
    const results: Array<{
      feed_item_id: string;
      risk_score: number;
      provenance_ok: boolean;
      creator_verified: boolean;
      payout_target_hint: string | null;
      trust_warnings: string[];
      safe_trust_summary: string;
    }> = [];

    for (const c of candidates) {
      const det = runDeterministicChecks({
        source_url: c.source_url,
        creator_wallet: c.creator_wallet,
        claim_status: c.claim_status,
      });
      const safeSummary = `Provenance: ${det.provenanceOk ? "ok" : "fail"}, creator: ${det.creatorVerified ? "verified" : "unverified"}, risk: ${det.riskScore.toFixed(2)}. Deterministic.`;
      results.push({
        feed_item_id: c.feed_item_id,
        risk_score: det.riskScore,
        provenance_ok: det.provenanceOk,
        creator_verified: det.creatorVerified,
        payout_target_hint: c.creator_wallet,
        trust_warnings: det.warnings,
        safe_trust_summary: safeSummary,
      });
    }

    const summary = `Trust Verifier batch: ${results.length} candidates, ${results.filter(r => r.risk_score < 0.5).length} low-risk.`;
    return {
      ok: true,
      serviceName: "trust_verifier",
      data: { results },
      safeSummary: summary,
      settled: false,
      error: null,
    };
  }

  // ── Single-item mode (backward compatible) ──
  const { feed_item_id, source_url, creator_wallet, claim_status } =
    input.payload as {
      feed_item_id: string;
      source_url: string;
      creator_wallet: string | null;
      claim_status: string;
    };

  // ── Deterministic checks (always runs, source of truth) ──
  const det = runDeterministicChecks({ source_url, creator_wallet, claim_status });

  const safeSummary = `Provenance: ${det.provenanceOk ? "ok" : "fail"}, creator: ${det.creatorVerified ? "verified" : "unverified"}, risk: ${det.riskScore.toFixed(2)}. Deterministic.`;

  // ── Deterministic mode: no LLM ──
  if (shouldRunServiceAsDeterministic("trust_verifier")) {
    return {
      ok: true,
      serviceName: "trust_verifier",
      data: {
        risk_score: det.riskScore,
        provenance_ok: det.provenanceOk,
        creator_verified: det.creatorVerified,
        payout_target_hint: creator_wallet,
        trust_warnings: det.warnings,
        safe_trust_summary: safeSummary,
      },
      safeSummary,
      settled: false,
      error: null,
    };
  }

  // ── Hybrid or LLM mode: use LLM for risk summary ──
  const { generateStructuredJson } = await import("@/lib/ai/llm-structured");
  const { toInternalRouteTier } = await import("./helpers");

  const result = await generateStructuredJson<z.infer<typeof TrustVerifierSchema>>({
    agentName: "trust_verifier",
    routeTier: toInternalRouteTier(routeTier || "easy"),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Source ID: ${feed_item_id}\nURL: ${source_url}\nCreator wallet: ${creator_wallet || "none"}\nClaim status: ${claim_status}\n\nDeterministic checks: provenance=${det.provenanceOk}, creator=${det.creatorVerified}, risk=${det.riskScore.toFixed(2)}, warnings=${JSON.stringify(det.warnings)}\n\nEvaluate trust. Return structured JSON only.`,
    schema: TrustVerifierSchema,
  });

  if (!result.ok) {
    // Fallback: deterministic only
    return {
      ok: true,
      serviceName: "trust_verifier",
      data: {
        risk_score: det.riskScore,
        provenance_ok: det.provenanceOk,
        creator_verified: det.creatorVerified,
        payout_target_hint: creator_wallet,
        trust_warnings: det.warnings,
        safe_trust_summary: `${safeSummary} (LLM failed, deterministic fallback)`,
      },
      safeSummary: `${safeSummary} (LLM failed, deterministic fallback)`,
      settled: false,
      error: null,
    };
  }

  // Hybrid: deterministic decisions are source of truth, LLM for summary only
  // LLM: LLM may suggest risk_score, but deterministic checks override
  return {
    ok: true,
    serviceName: "trust_verifier",
    data: {
      risk_score: shouldRunServiceAsHybrid("trust_verifier")
        ? det.riskScore // hybrid: deterministic risk score is source of truth
        : result.data.risk_score, // llm: LLM may suggest (but deterministic checks still override)
      provenance_ok: det.provenanceOk, // always deterministic
      creator_verified: det.creatorVerified, // always deterministic
      payout_target_hint: creator_wallet,
      trust_warnings: [...det.warnings, ...result.data.trust_warnings],
      safe_trust_summary: result.data.safe_summary,
    },
    safeSummary: result.data.safe_summary,
    settled: false,
    error: null,
  };
};
