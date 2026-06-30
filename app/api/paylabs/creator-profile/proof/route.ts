/**
 * Creator Proof Self-Check Endpoint
 *
 * POST: Creator triggers proof verification for their claim.
 * Auth: UCW session (ucw_sid cookie). No Bearer token. No admin secret.
 *
 * Rules:
 * - claim must belong to session wallet
 * - calls deterministic verifyCreatorClaimProof
 * - updates paylabs_creator_claims based on result
 * - no LLM, no admin secret, no NEXT_PUBLIC secret
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { getSession, refreshSession } from "@/lib/paylabs/ucw";
import { verifyCreatorClaimProof } from "@/lib/paylabs/creator-distribution/proof-verifier";

const VALID_PROOF_TYPES = new Set(["well_known_json", "dns_txt"]);

const SAFE_CLAIM_COLUMNS =
  "id, creator_wallet, creator_name, source_url, source_domain, claim_status, verification_method, verified_at, created_at, updated_at, proof_type, proof_nonce, proof_status, proof_checked_at, proof_error";

export async function POST(req: NextRequest) {
  // Auth via UCW session
  const sid = req.cookies.get("ucw_sid")?.value;
  if (!sid) {
    return NextResponse.json({ error: "Session required" }, { status: 401 });
  }

  const session = await getSession(sid);
  if (!session?.walletAddress) {
    return NextResponse.json(
      { error: "Connected Creator Wallet required" },
      { status: 401 },
    );
  }

  const walletAddress = session.walletAddress.toLowerCase();

  // Parse body
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const claimId =
    typeof body.claim_id === "string" ? body.claim_id.trim() : "";
  const proofType =
    typeof body.proof_type === "string" ? body.proof_type.trim() : "";

  if (!claimId) {
    return NextResponse.json({ error: "claim_id required" }, { status: 400 });
  }
  if (!VALID_PROOF_TYPES.has(proofType)) {
    return NextResponse.json(
      { error: "proof_type must be well_known_json or dns_txt" },
      { status: 400 },
    );
  }

  const db = supabaseAdmin();

  // Load claim
  const { data: existing, error: loadError } = await db
    .from("paylabs_creator_claims")
    .select("*")
    .eq("id", claimId)
    .single();

  if (loadError || !existing) {
    return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  }

  const claim = existing as Record<string, unknown>;

  // Verify claim belongs to session wallet
  const claimWallet = (
    (claim.creator_wallet as string) || ""
  ).toLowerCase();
  if (claimWallet !== walletAddress) {
    return NextResponse.json(
      { error: "Claim does not belong to your wallet" },
      { status: 403 },
    );
  }

  // Already verified — return current state
  if (claim.claim_status === "verified") {
    if (sid) await refreshSession(sid);
    return NextResponse.json({
      ok: true,
      already_verified: true,
      claim: claim as Record<string, unknown>,
    });
  }

  // Reject if claim_status is locked (rejected/revoked)
  if (
    claim.claim_status === "rejected" ||
    claim.claim_status === "revoked"
  ) {
    return NextResponse.json(
      { error: `Claim is ${claim.claim_status}; cannot verify` },
      { status: 409 },
    );
  }

  // Ensure proof_nonce exists
  if (!claim.proof_nonce) {
    return NextResponse.json(
      { error: "Claim has no proof_nonce. Re-submit your source first." },
      { status: 400 },
    );
  }

  // Run deterministic proof verification
  const result = await verifyCreatorClaimProof(
    claim as unknown as Parameters<typeof verifyCreatorClaimProof>[0],
    proofType as "well_known_json" | "dns_txt",
  );

  const now = new Date().toISOString();

  if (result.ok) {
    // Success
    const { data: updated, error: updateError } = await db
      .from("paylabs_creator_claims")
      .update({
        claim_status: "verified",
        proof_status: "verified",
        proof_type: result.proof_type,
        verified_at: now,
        verification_method: result.proof_type,
        proof_checked_at: now,
        proof_error: null,
        proof_evidence_hash: result.proof_evidence_hash,
        updated_at: now,
      })
      .eq("id", claimId)
      .select(SAFE_CLAIM_COLUMNS)
      .single();

    if (updateError) {
      console.error("[creator-proof] update failed", {
        code: updateError.code,
      });
      return NextResponse.json(
        { error: "Failed to update claim" },
        { status: 500 },
      );
    }

    if (sid) await refreshSession(sid);
    return NextResponse.json({
      ok: true,
      verified: true,
      claim: updated,
    });
  } else {
    // Failure — do NOT set claim_status="rejected"
    const { data: updated, error: updateError } = await db
      .from("paylabs_creator_claims")
      .update({
        proof_status: "failed",
        proof_type: result.proof_type,
        proof_checked_at: now,
        proof_error: result.proof_error,
        updated_at: now,
      })
      .eq("id", claimId)
      .select(SAFE_CLAIM_COLUMNS)
      .single();

    if (updateError) {
      console.error("[creator-proof] update failed", {
        code: updateError.code,
      });
      return NextResponse.json(
        { error: "Failed to update claim" },
        { status: 500 },
      );
    }

    if (sid) await refreshSession(sid);
    return NextResponse.json({
      ok: false,
      verified: false,
      proof_error: result.proof_error,
      claim: updated,
    });
  }
}
