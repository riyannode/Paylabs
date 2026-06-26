/**
 * Creator Attribution Handler
 *
 * Deterministic service that classifies creator eligibility for payout.
 * No LLM. No payment. Validates wallets and claim status.
 *
 * Calls claim-policy.ts and source-selection.ts.
 * Does not decide amounts.
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
