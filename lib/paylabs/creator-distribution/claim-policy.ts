/**
 * Creator Claim Policy
 *
 * Deterministic classification of creator eligibility for payout.
 * No LLM. No network. Pure rules.
 *
 * Rules:
 * - Payout only if creator_wallet is valid EVM address (0x + 40 hex chars)
 * - Payout only if claim_status is "verified"
 * - Unclaimed source → pending_claim
 * - Invalid wallet → failed_closed
 * - Missing wallet → pending_claim
 * - Live/unverified source must not be paid
 * - No fake paid status
 */

import type {
  ApprovedCreatorItem,
  CreatorAttribution,
} from "./types";

// ─── EVM Address Validation ───────────────────────────────────

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function isValidEvmAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  return EVM_ADDRESS_RE.test(addr);
}

// ─── Claim Classification ─────────────────────────────────────

/**
 * Classify a single approved creator item for payout eligibility.
 * Deterministic — no LLM, no network, no side effects.
 */
export function classifyCreatorClaim(
  item: ApprovedCreatorItem
): CreatorAttribution {
  const base = {
    feed_item_id: item.feed_item_id,
    source_url: item.source_url,
    source_title: item.source_title,
    final_score: item.final_score,
    risk_score: item.risk_score,
  };

  const claimStatus = (item.claim_status || "unknown") as CreatorAttribution["claim_status"];

  // Missing wallet → pending_claim
  if (!item.creator_wallet) {
    return {
      ...base,
      creator_wallet: null,
      claim_status: claimStatus === "verified" ? "verified" : "unclaimed",
      eligibility_status: "pending_claim",
      reason: "creator_wallet_missing",
    };
  }

  // Invalid wallet format → failed_closed
  if (!isValidEvmAddress(item.creator_wallet)) {
    return {
      ...base,
      creator_wallet: item.creator_wallet,
      claim_status: "invalid",
      eligibility_status: "failed_closed",
      reason: "creator_wallet_invalid_format",
    };
  }

  // Unverified claim → ineligible
  if (claimStatus !== "verified") {
    return {
      ...base,
      creator_wallet: item.creator_wallet,
      claim_status: claimStatus,
      eligibility_status: "pending_claim",
      reason: `claim_status_${claimStatus}`,
    };
  }

  // Verified wallet + valid address → eligible
  return {
    ...base,
    creator_wallet: item.creator_wallet,
    claim_status: "verified",
    eligibility_status: "eligible",
    reason: "verified_creator",
  };
}
