import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { getSession, refreshSession } from "@/lib/paylabs/ucw";

type CreatorClaim = {
  id: string;
  creator_wallet: string;
  creator_name: string | null;
  source_url: string | null;
  source_domain: string | null;
  claim_status: "verified" | "unclaimed" | "rejected" | "revoked" | "unknown";
  verification_method: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
};

const SAFE_CLAIM_COLUMNS = "id, creator_wallet, creator_name, source_url, source_domain, claim_status, verification_method, verified_at, created_at, updated_at";
const LOCKED_STATUSES = new Set(["verified", "rejected", "revoked"]);

function creatorProfileDbError(step: string, error: { code?: string | null }) {
  console.error("[creator-profile] safe step failed", { step, code: error.code ?? null });
  return NextResponse.json({ error: "Creator profile request failed." }, { status: 500 });
}

async function getWalletSession(req: NextRequest) {
  const sid = req.cookies.get("ucw_sid")?.value;
  if (!sid) return { sid: null, walletAddress: null };
  const session = await getSession(sid);
  if (!session?.walletAddress) return { sid, walletAddress: null };
  return { sid, walletAddress: session.walletAddress.toLowerCase() };
}

function parseHttpsUrl(value: unknown): { url?: string; domain?: string; error?: string } {
  if (typeof value !== "string") return { error: "source_url is required" };
  const trimmed = value.trim();
  if (!trimmed) return { error: "source_url is required" };
  if (trimmed.length > 1000) return { error: "source_url must be 1000 characters or less" };
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return { error: "source_url must be an HTTPS URL" };
    return { url: url.toString(), domain: url.hostname.toLowerCase() };
  } catch {
    return { error: "source_url must be a valid HTTPS URL" };
  }
}

export async function GET(req: NextRequest) {
  const { sid, walletAddress } = await getWalletSession(req);
  if (!walletAddress) {
    return NextResponse.json({ walletAddress: null, claims: [] }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin()
    .from("paylabs_creator_claims")
    .select(SAFE_CLAIM_COLUMNS)
    .eq("creator_wallet", walletAddress)
    .order("updated_at", { ascending: false });

  if (error) return creatorProfileDbError("get_claims", error);
  if (sid) await refreshSession(sid);

  return NextResponse.json({ walletAddress, claims: (data ?? []) as CreatorClaim[] });
}

export async function POST(req: NextRequest) {
  const { sid, walletAddress } = await getWalletSession(req);
  if (!walletAddress) {
    return NextResponse.json({ error: "Connected UCW creator wallet required" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { creator_name?: unknown; source_url?: unknown };
  const creatorName = typeof body.creator_name === "string" ? body.creator_name.trim() : "";
  if (creatorName.length < 2 || creatorName.length > 80) {
    return NextResponse.json({ error: "creator_name must be 2-80 characters" }, { status: 400 });
  }

  const parsed = parseHttpsUrl(body.source_url);
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const supabase = supabaseAdmin();
  const { data: existing, error: selectError } = await supabase
    .from("paylabs_creator_claims")
    .select(SAFE_CLAIM_COLUMNS)
    .eq("creator_wallet", walletAddress)
    .eq("source_url", parsed.url)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (selectError) return creatorProfileDbError("select_claim", selectError);

  const existingClaim = (existing?.[0] ?? null) as CreatorClaim | null;
  if (existingClaim && LOCKED_STATUSES.has(existingClaim.claim_status)) {
    return NextResponse.json(
      { error: `Existing ${existingClaim.claim_status} claim cannot be overwritten silently`, claim: existingClaim, walletAddress },
      { status: 409 },
    );
  }

  if (existingClaim) {
    const { data, error } = await supabase
      .from("paylabs_creator_claims")
      .update({
        creator_name: creatorName,
        source_domain: parsed.domain,
        claim_status: "unclaimed",
        verification_method: "manual_review",
        verified_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingClaim.id)
      .select(SAFE_CLAIM_COLUMNS)
      .single();

    if (error) return creatorProfileDbError("update_claim", error);
    if (sid) await refreshSession(sid);
    return NextResponse.json({ walletAddress, claim: data as CreatorClaim });
  }

  const { data, error } = await supabase
    .from("paylabs_creator_claims")
    .insert({
      creator_wallet: walletAddress,
      creator_name: creatorName,
      source_url: parsed.url,
      source_domain: parsed.domain,
      claim_status: "unclaimed",
      verification_method: "manual_review",
      verified_at: null,
    })
    .select(SAFE_CLAIM_COLUMNS)
    .single();

  if (error) return creatorProfileDbError("insert_claim", error);
  if (sid) await refreshSession(sid);

  return NextResponse.json({ walletAddress, claim: data as CreatorClaim });
}
