/**
 * Public Creator Proof Page
 *
 * URL: /creator-proof/<claimId>/<nonce>
 *
 * This page is the verification link that creators paste into their
 * public profile bio, README, or page. When a visitor opens it,
 * they see a "PayLabs Verified Creator" confirmation.
 *
 * The page validates:
 * 1. claimId exists in paylabs_creator_claims
 * 2. nonce matches the claim's proof_nonce
 * 3. claim_status is 'verified'
 *
 * If any check fails, shows a generic "not found" page (no leak).
 */

import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { notFound } from "next/navigation";

interface PageProps {
  params: Promise<{ claimId: string; nonce: string }>;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export async function generateMetadata({ params }: PageProps) {
  const { claimId, nonce } = await params;

  // Quick check — don't leak info if invalid
  const db = supabaseAdmin();
  const { data } = await db
    .from("paylabs_creator_claims")
    .select("id, creator_name, claim_status, proof_nonce")
    .eq("id", claimId)
    .eq("proof_nonce", nonce)
    .eq("claim_status", "verified")
    .limit(1)
    .single();

  if (!data) {
    return { title: "PayLabs — Creator Not Found" };
  }

  const name = data.creator_name || "PayLabs Creator";
  return {
    title: `${name} — PayLabs Verified Creator`,
    description: `${name} is a verified PayLabs creator. Their content is eligible for AI-powered creator payouts.`,
    openGraph: {
      title: `${name} — PayLabs Verified Creator`,
      description: `Verified creator on PayLabs. Content is eligible for automatic creator payouts.`,
    },
  };
}

export default async function CreatorProofPage({ params }: PageProps) {
  const { claimId, nonce } = await params;

  const db = supabaseAdmin();
  const { data: claim } = await db
    .from("paylabs_creator_claims")
    .select("id, creator_wallet, creator_name, source_url, source_domain, claim_status, proof_nonce, verified_at")
    .eq("id", claimId)
    .eq("proof_nonce", nonce)
    .eq("claim_status", "verified")
    .limit(1)
    .single();

  if (!claim) {
    notFound();
  }

  const name = claim.creator_name || "PayLabs Creator";
  const wallet = claim.creator_wallet ? shortAddress(claim.creator_wallet) : null;
  const domain = claim.source_domain || null;
  const verifiedAt = claim.verified_at
    ? new Date(claim.verified_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : null;

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "var(--bg, #0a0a0a)",
        color: "var(--text, #e5e5e5)",
      }}
    >
      <div
        style={{
          maxWidth: 480,
          width: "100%",
          display: "grid",
          gap: 20,
          padding: 32,
          borderRadius: 16,
          border: "1px solid var(--border, #222)",
          background: "var(--surface, #111)",
          textAlign: "center",
        }}
      >
        {/* Verified badge */}
        <div style={{ fontSize: 48, lineHeight: 1 }}>✅</div>

        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 8px" }}>
            Verified PayLabs Creator
          </h1>
          <p style={{ fontSize: 16, fontWeight: 600, margin: 0, color: "var(--muted, #888)" }}>
            {name}
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gap: 8,
            fontSize: 13,
            color: "var(--muted, #888)",
            textAlign: "left",
            padding: "12px 16px",
            borderRadius: 10,
            background: "var(--bg, #0a0a0a)",
          }}
        >
          {domain && (
            <div>
              <span style={{ fontWeight: 600 }}>Source:</span>{" "}
              <span>{domain}</span>
            </div>
          )}
          {wallet && (
            <div>
              <span style={{ fontWeight: 600 }}>Creator Wallet:</span>{" "}
              <code style={{ fontSize: 12 }}>{wallet}</code>
            </div>
          )}
          {verifiedAt && (
            <div>
              <span style={{ fontWeight: 600 }}>Verified:</span>{" "}
              <span>{verifiedAt}</span>
            </div>
          )}
        </div>

        <p style={{ fontSize: 12, color: "var(--muted, #666)", margin: 0 }}>
          This creator has verified ownership of their content source.
          When AI agents use their content through PayLabs, the creator
          receives automatic payouts.
        </p>

        <a
          href="/chat"
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "#2563eb",
            textDecoration: "none",
          }}
        >
          Learn more about PayLabs →
        </a>
      </div>
    </div>
  );
}
