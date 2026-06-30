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

  // Best-effort: propagate verified claim to matching RSSHub route
  if (action === "verify") {
    await propagateVerificationToRoute(db, updated as Record<string, unknown>);
  }

  return NextResponse.json({ claim: updated });
}

// ─── Best-effort route propagation ─────────────────────────────

async function propagateVerificationToRoute(
  db: ReturnType<typeof supabaseAdmin>,
  claim: Record<string, unknown>,
): Promise<void> {
  try {
    const sourceUrl = claim.source_url as string | null;
    const sourceDomain = claim.source_domain as string | null;
    const creatorWallet = claim.creator_wallet as string | null;

    if (!creatorWallet) return;

    // Try to find matching route by source_domain
    if (sourceDomain) {
      // RSSHub routes don't have a direct domain column, but route_path often
      // contains domain info. Try matching on title or route_path containing domain.
      // For now, do best-effort: check if any route's rsshub_base_url contains the domain.
      const { data: routes } = await db
        .from("paylabs_rsshub_routes")
        .select("id, rsshub_base_url, route_path, title")
        .eq("is_active", true)
        .limit(10);

      if (routes && routes.length > 0) {
        const matchingRoute = routes.find((r: Record<string, unknown>) => {
          const baseUrl = String(r.rsshub_base_url || "").toLowerCase();
          const title = String(r.title || "").toLowerCase();
          const domain = sourceDomain.toLowerCase();
          return baseUrl.includes(domain) || title.includes(domain);
        });

        if (matchingRoute) {
          await db
            .from("paylabs_rsshub_routes")
            .update({
              verification_status: "verified",
              is_monetized: true,
              creator_wallet: creatorWallet,
              verified_at: new Date().toISOString(),
              verification_method: "admin_approved",
            })
            .eq("id", matchingRoute.id);
        }
      }
    }
  } catch {
    // Best-effort — do not fail the claim verification
  }
}
