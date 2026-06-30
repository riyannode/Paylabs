/**
 * Creator Claim Resolver
 *
 * Deterministic lookup of verified creator claims from paylabs_creator_claims.
 * No LLM. No auto-verification. No side effects.
 *
 * Used by Payment Decision and Discovery Planner to enrich source candidates
 * with verified creator wallet info.
 */

import { supabaseAdmin } from "@/lib/supabase/server";

// ─── Types ─────────────────────────────────────────────────────

export interface ResolvedCreatorClaim {
  creator_wallet: string;
  claim_status: "verified";
  source_url: string | null;
  source_domain: string | null;
  verification_method: string | null;
  verified_at: string | null;
}

export type ClaimVisibility =
  | "eligible" // verified + valid wallet
  | "pending_claim" // unclaimed / unknown
  | "ineligible" // rejected / revoked / invalid wallet
  | "not_found"; // no claim exists

export interface ClaimVisibilityResult {
  visibility: ClaimVisibility;
  claim_status: string | null;
  creator_wallet: string | null;
  reason: string;
}

// ─── EVM Validation ────────────────────────────────────────────

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

function isValidEvmAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  return EVM_RE.test(addr);
}

// ─── Domain Derivation ─────────────────────────────────────────

export function deriveHttpsDomain(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null;
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:") return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

// ─── Verified Claim Resolver ───────────────────────────────────

/**
 * Resolve a verified creator claim for a given source URL or domain.
 *
 * Matching priority:
 * 1. Exact source_url match where claim_status="verified"
 * 2. source_domain match where claim_status="verified"
 * 3. Most recently verified/updated wins if multiple match.
 *
 * Returns null if no verified claim with valid EVM wallet exists.
 */
export async function resolveVerifiedCreatorClaimForSource(input: {
  sourceUrl?: string | null;
  sourceDomain?: string | null;
}): Promise<ResolvedCreatorClaim | null> {
  const db = supabaseAdmin();
  const domain = input.sourceDomain || deriveHttpsDomain(input.sourceUrl);

  // Try exact source_url match first
  if (input.sourceUrl) {
    const { data: urlMatches } = await db
      .from("paylabs_creator_claims")
      .select(
        "id, creator_wallet, source_url, source_domain, claim_status, verification_method, verified_at, updated_at",
      )
      .eq("source_url", input.sourceUrl)
      .eq("claim_status", "verified")
      .order("verified_at", { ascending: false, nullsFirst: false })
      .order("updated_at", { ascending: false })
      .limit(1);

    const urlClaim = urlMatches?.[0] as Record<string, unknown> | undefined;
    if (urlClaim && isValidEvmAddress(urlClaim.creator_wallet as string)) {
      return {
        creator_wallet: (urlClaim.creator_wallet as string).toLowerCase(),
        claim_status: "verified",
        source_url: urlClaim.source_url as string | null,
        source_domain: urlClaim.source_domain as string | null,
        verification_method: urlClaim.verification_method as string | null,
        verified_at: urlClaim.verified_at as string | null,
      };
    }
  }

  // Try source_domain match
  if (domain) {
    const { data: domainMatches } = await db
      .from("paylabs_creator_claims")
      .select(
        "id, creator_wallet, source_url, source_domain, claim_status, verification_method, verified_at, updated_at",
      )
      .eq("source_domain", domain)
      .eq("claim_status", "verified")
      .order("verified_at", { ascending: false, nullsFirst: false })
      .order("updated_at", { ascending: false })
      .limit(1);

    const domainClaim = domainMatches?.[0] as Record<string, unknown> | undefined;
    if (domainClaim && isValidEvmAddress(domainClaim.creator_wallet as string)) {
      return {
        creator_wallet: (domainClaim.creator_wallet as string).toLowerCase(),
        claim_status: "verified",
        source_url: domainClaim.source_url as string | null,
        source_domain: domainClaim.source_domain as string | null,
        verification_method: domainClaim.verification_method as string | null,
        verified_at: domainClaim.verified_at as string | null,
      };
    }
  }

  return null;
}

// ─── Claim Visibility (for safe audit/reporting) ───────────────

/**
 * Classify claim visibility for a source. Used for safe summaries,
 * NOT for payout decisions (that uses resolveVerifiedCreatorClaimForSource).
 */
export async function resolveClaimVisibilityForSource(input: {
  sourceUrl?: string | null;
  sourceDomain?: string | null;
}): Promise<ClaimVisibilityResult> {
  const db = supabaseAdmin();
  const domain = input.sourceDomain || deriveHttpsDomain(input.sourceUrl);

  // Find any claim (not just verified) for visibility
  const conditions: Array<{ column: string; value: string }> = [];
  if (input.sourceUrl) {
    conditions.push({ column: "source_url", value: input.sourceUrl });
  }
  if (domain) {
    conditions.push({ column: "source_domain", value: domain });
  }

  if (conditions.length === 0) {
    return {
      visibility: "not_found",
      claim_status: null,
      creator_wallet: null,
      reason: "no_source_identified",
    };
  }

  // Query by source_url first, then domain
  let claim: Record<string, unknown> | null = null;

  if (input.sourceUrl) {
    const { data } = await db
      .from("paylabs_creator_claims")
      .select("claim_status, creator_wallet, source_url, source_domain")
      .eq("source_url", input.sourceUrl)
      .order("updated_at", { ascending: false })
      .limit(1);
    claim = (data?.[0] as Record<string, unknown>) ?? null;
  }

  if (!claim && domain) {
    const { data } = await db
      .from("paylabs_creator_claims")
      .select("claim_status, creator_wallet, source_url, source_domain")
      .eq("source_domain", domain)
      .order("updated_at", { ascending: false })
      .limit(1);
    claim = (data?.[0] as Record<string, unknown>) ?? null;
  }

  if (!claim) {
    return {
      visibility: "not_found",
      claim_status: null,
      creator_wallet: null,
      reason: "no_claim_for_source",
    };
  }

  const status = claim.claim_status as string;
  const wallet = claim.creator_wallet as string | null;

  if (status === "verified") {
    if (!isValidEvmAddress(wallet)) {
      return {
        visibility: "ineligible",
        claim_status: status,
        creator_wallet: wallet,
        reason: "verified_but_invalid_wallet",
      };
    }
    return {
      visibility: "eligible",
      claim_status: status,
      creator_wallet: wallet,
      reason: "verified_creator",
    };
  }

  if (status === "rejected" || status === "revoked") {
    return {
      visibility: "ineligible",
      claim_status: status,
      creator_wallet: wallet,
      reason: `claim_${status}`,
    };
  }

  // unclaimed / unknown / other
  return {
    visibility: "pending_claim",
    claim_status: status,
    creator_wallet: wallet,
    reason: `claim_${status}_awaiting_review`,
  };
}
