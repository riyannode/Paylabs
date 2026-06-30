/**
 * Creator Profile Admin Approval Endpoint
 *
 * PATCH: Verify / reject / revoke a creator claim.
 * Bearer auth required. No UI in this PR.
 *
 * Auth priority:
 *   PAYLABS_CREATOR_ADMIN_SECRET
 *   → PAYLABS_RSSHUB_ADMIN_SECRET
 *   → PAYLABS_RSSHUB_SYNC_SECRET
 *
 * Rules:
 * - Do not auto-verify on creator POST.
 * - Only this admin PATCH can set claim_status=verified.
 * - Do not expose the secret or log the token.
 * - Do not touch UCW/DCW auth.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

// ─── Auth ──────────────────────────────────────────────────────

function getAdminSecret(): string | null {
  return (
    process.env.PAYLABS_CREATOR_ADMIN_SECRET ||
    process.env.PAYLABS_RSSHUB_ADMIN_SECRET ||
    process.env.PAYLABS_RSSHUB_SYNC_SECRET ||
    null
  );
}

function requireAdminAuth(req: NextRequest): NextResponse | null {
  const secret = getAdminSecret();
  if (!secret) {
    return NextResponse.json(
      { error: "Creator admin not configured" },
      { status: 503 },
    );
  }
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (token !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

// ─── EVM Validation ────────────────────────────────────────────

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

function isValidEvmAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  return EVM_RE.test(addr);
}

// ─── Types ─────────────────────────────────────────────────────

const VALID_ACTIONS = new Set(["verify", "reject", "revoke"]);
const SAFE_CLAIM_COLUMNS =
  "id, creator_wallet, creator_name, source_url, source_domain, claim_status, verification_method, verified_at, updated_at";

// ─── PATCH ─────────────────────────────────────────────────────

export async function PATCH(req: NextRequest) {
  const authError = requireAdminAuth(req);
  if (authError) return authError;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const claimId = typeof body.claim_id === "string" ? body.claim_id.trim() : "";
  const action = typeof body.action === "string" ? body.action.trim() : "";

  if (!claimId) {
    return NextResponse.json({ error: "claim_id required" }, { status: 400 });
  }
  if (!VALID_ACTIONS.has(action)) {
    return NextResponse.json(
      { error: "action must be verify, reject, or revoke" },
      { status: 400 },
    );
  }

  const db = supabaseAdmin();

  // Load existing claim
  const { data: existing, error: loadError } = await db
    .from("paylabs_creator_claims")
    .select(SAFE_CLAIM_COLUMNS)
    .eq("id", claimId)
    .single();

  if (loadError || !existing) {
    return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  }

  const claim = existing as Record<string, unknown>;

  // Build update fields
  const now = new Date().toISOString();
  const updateFields: Record<string, unknown> = {
    updated_at: now,
  };

  if (action === "verify") {
    // Validate creator_wallet is valid EVM before verify
    if (!isValidEvmAddress(claim.creator_wallet as string)) {
      return NextResponse.json(
        { error: "Creator wallet is not a valid EVM address; cannot verify" },
        { status: 400 },
      );
    }
    // Validate source_url is HTTPS if present
    const sourceUrl = claim.source_url as string | null;
    if (sourceUrl) {
      try {
        const parsed = new URL(sourceUrl);
        if (parsed.protocol !== "https:") {
          return NextResponse.json(
            { error: "source_url must be HTTPS; cannot verify" },
            { status: 400 },
          );
        }
      } catch {
        return NextResponse.json(
          { error: "source_url is not a valid URL; cannot verify" },
          { status: 400 },
        );
      }
    }

    updateFields.claim_status = "verified";
    updateFields.verified_at = now;
    updateFields.verification_method = "admin_approved";
  } else if (action === "reject") {
    updateFields.claim_status = "rejected";
    updateFields.verified_at = null;
    updateFields.verification_method = "manual_review";
  } else if (action === "revoke") {
    updateFields.claim_status = "revoked";
    updateFields.verified_at = null;
    updateFields.verification_method = "manual_review";
  }

  const { data: updated, error: updateError } = await db
    .from("paylabs_creator_claims")
    .update(updateFields)
    .eq("id", claimId)
    .select(SAFE_CLAIM_COLUMNS)
    .single();

  if (updateError) {
    console.error("[creator-profile-admin] update failed", {
      code: updateError.code,
    });
    return NextResponse.json(
      { error: "Failed to update claim" },
      { status: 500 },
    );
  }

  return NextResponse.json({ claim: updated });
}
