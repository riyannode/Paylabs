/**
 * Creator Attribution Handler
 *
 * Deterministic service that classifies creator eligibility for payout.
 * No LLM. No payment. Validates wallets and claim status.
 *
 * Calls claim-policy.ts and source-selection.ts.
 * Does not decide amounts.
 *
 * Persists attribution decisions to paylabs_source_attributions for audit.
 */

import type {
  ServiceHandlerInput,
  ServiceHandlerOutput,
} from "../types";
import {
  classifyCreatorClaim,
} from "../../creator-distribution/claim-policy";
import {
  selectCreatorPayoutItems,
} from "../../creator-distribution/source-selection";
import type {
  ApprovedCreatorItem,
  CreatorAttribution,
} from "../../creator-distribution/types";
import { supabaseAdmin } from "@/lib/supabase/server";

async function persistAttributions(
  discoveryRunId: string,
  attributions: CreatorAttribution[],
): Promise<{ ok: boolean; error?: string }> {
  try {
    const db = supabaseAdmin();
    const rows = attributions.map((a) => ({
      discovery_run_id: discoveryRunId,
      feed_item_id: a.feed_item_id,
      source_url: a.source_url,
      source_title: a.source_title,
      creator_wallet: a.creator_wallet,
      claim_status: a.claim_status,
      eligibility_status: a.eligibility_status,
      final_score: a.final_score,
      risk_score: a.risk_score,
      attribution_reason: a.reason,
    }));

    const { error } = await db.from("paylabs_source_attributions").insert(rows);
    if (error) {
      console.error("[creator-attribution] persist error:", error.message);
      return { ok: false, error: `attribution_persist_failed: ${error.message}` };
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[creator-attribution] persist exception:", msg);
    return { ok: false, error: `attribution_persist_exception: ${msg}` };
  }
}

export async function creatorAttributionHandler(
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> {
  const payload = input.payload as {
    approved_items?: ApprovedCreatorItem[];
    routeTier?: string;
  };

  const approvedItems = payload.approved_items || [];
  const routeTier = (payload.routeTier || "normal") as "easy" | "normal" | "advanced";

  // Classify each item
  const attributions: CreatorAttribution[] = approvedItems.map((item) =>
    classifyCreatorClaim(item)
  );

  // Select eligible items for payout
  const eligibleItems = selectCreatorPayoutItems(routeTier, attributions);
  const pendingClaimItems = attributions.filter(
    (a) => a.eligibility_status === "pending_claim"
  );
  const failedClosedItems = attributions.filter(
    (a) => a.eligibility_status === "failed_closed"
  );

  // Persist attributions for audit trail — fail closed if persistence fails
  const persistResult = await persistAttributions(input.discoveryRunId, attributions);

  if (!persistResult.ok) {
    return {
      ok: false,
      serviceName: "creator_attribution",
      data: {
        creator_attributions: attributions,
        eligible_creator_items: eligibleItems,
        pending_claim_items: pendingClaimItems,
        failed_closed_items: failedClosedItems,
        safe_summary: `Creator attribution computed but audit persistence failed: ${persistResult.error}`,
      },
      safeSummary: `Creator attribution: persistence failed — audit trail incomplete.`,
      settled: false,
      error: persistResult.error || "attribution_persist_failed",
    };
  }

  return {
    ok: true,
    serviceName: "creator_attribution",
    data: {
      creator_attributions: attributions,
      eligible_creator_items: eligibleItems,
      pending_claim_items: pendingClaimItems,
      failed_closed_items: failedClosedItems,
      safe_summary: `Creator attribution: ${eligibleItems.length} eligible, ${pendingClaimItems.length} pending claim, ${failedClosedItems.length} failed closed.`,
    },
    safeSummary: `Creator attribution: ${eligibleItems.length} eligible for payout out of ${attributions.length} total.`,
    settled: false,
    error: null,
  };
}
