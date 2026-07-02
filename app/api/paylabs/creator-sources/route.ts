import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { getSession, refreshSession } from "@/lib/paylabs/ucw";
import { canonicalUrlMatchesClaim, type ClaimMatchInput } from "@/lib/paylabs/creator-distribution/claim-resolver";

// ─── Types ─────────────────────────────────────────────────────

type CreatorSource = {
  id: string;
  creator_name: string | null;
  source_url: string | null;
  source_domain: string | null;
  canonical_url: string | null;
  claim_scope: string | null;
  claim_scope_key: string | null;
  source_platform: string | null;
  claim_status: string;
  proof_status: string | null;
  proof_method: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
  feed_items_count: number;
  monetization_status: string;
};

// ─── Constants ─────────────────────────────────────────────────

const SAFE_CLAIM_COLUMNS =
  "id, creator_name, source_url, source_domain, canonical_url, claim_scope, claim_scope_key, source_platform, claim_status, proof_status, proof_method, verified_at, created_at, updated_at";

// ─── Helpers ───────────────────────────────────────────────────

async function getWalletSession(req: NextRequest) {
  const sid = req.cookies.get("ucw_sid")?.value;
  if (!sid) return { sid: null, walletAddress: null };
  const session = await getSession(sid);
  if (!session?.walletAddress) return { sid, walletAddress: null };
  return { sid, walletAddress: session.walletAddress.toLowerCase() };
}

function deriveMonetizationStatus(claimStatus: string, feedItemsCount: number): string {
  if (claimStatus === "verified" && feedItemsCount > 0) return "indexed_monetized";
  if (claimStatus === "verified" && feedItemsCount === 0) return "verified_awaiting_ingestion";
  if (claimStatus === "unclaimed") return "pending_verification";
  return "inactive";
}

// ─── GET ──────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { sid, walletAddress } = await getWalletSession(req);
  if (!walletAddress) {
    return NextResponse.json({ walletAddress: null, sources: [] });
  }

  const supabase = supabaseAdmin();

  // 1. Load all claims for this wallet
  const { data: claims, error: claimsError } = await supabase
    .from("paylabs_creator_claims")
    .select(SAFE_CLAIM_COLUMNS)
    .eq("creator_wallet", walletAddress)
    .order("updated_at", { ascending: false });

  if (claimsError) {
    console.error("[creator-sources] failed to load claims", { code: claimsError.code ?? null });
    return NextResponse.json({ error: "Failed to load creator sources." }, { status: 500 });
  }

  if (!claims || claims.length === 0) {
    if (sid) await refreshSession(sid);
    return NextResponse.json({ walletAddress, sources: [] });
  }

  // 2. Fetch all payable feed items for this wallet (canonical_url + price)
  const { data: payableItems, error: payableItemsError } = await supabase
    .from("paylabs_feed_items")
    .select("canonical_url, price_per_citation_usdc")
    .eq("is_active", true)
    .eq("is_monetized", true)
    .eq("claim_status", "claimed")
    .eq("creator_wallet", walletAddress);

  if (payableItemsError) {
    console.error("[creator-sources] failed to load payable feed items", { code: payableItemsError.code ?? null });
    return NextResponse.json({ error: "Failed to load indexed feed items." }, { status: 500 });
  }

  // Only count rows with positive citation price as truly payable
  const payableUrls = payableItems
    ?.filter((r) => (r.price_per_citation_usdc ?? 0) > 0)
    .map((r) => r.canonical_url)
    .filter(Boolean) as string[] ?? [];

  // 3. Per-claim feed item count using exact scope matching
  const sources: CreatorSource[] = claims.map((claim) => {
    const matchInput: ClaimMatchInput = {
      claim_scope: claim.claim_scope,
      claim_scope_key: claim.claim_scope_key,
      source_url: claim.source_url,
      source_domain: claim.source_domain,
      canonical_url: claim.canonical_url,
    };

    let feedItemsCount = 0;
    for (const url of payableUrls) {
      if (canonicalUrlMatchesClaim(url, matchInput)) {
        feedItemsCount++;
      }
    }

    return {
      id: claim.id,
      creator_name: claim.creator_name,
      source_url: claim.source_url,
      source_domain: claim.source_domain,
      canonical_url: claim.canonical_url,
      claim_scope: claim.claim_scope,
      claim_scope_key: claim.claim_scope_key,
      source_platform: claim.source_platform,
      claim_status: claim.claim_status,
      proof_status: claim.proof_status,
      proof_method: claim.proof_method,
      verified_at: claim.verified_at,
      created_at: claim.created_at,
      updated_at: claim.updated_at,
      feed_items_count: feedItemsCount,
      monetization_status: deriveMonetizationStatus(claim.claim_status, feedItemsCount),
    };
  });

  if (sid) await refreshSession(sid);

  return NextResponse.json({ walletAddress, sources });
}
