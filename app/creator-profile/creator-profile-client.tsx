"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type ClaimStatus = "unclaimed" | "verified" | "rejected" | "revoked" | "unknown";
type ProofStatus = "not_started" | "pending" | "verified" | "failed" | "manual_required";

type CreatorClaim = {
  id: string;
  creator_wallet: string;
  creator_name: string | null;
  source_url: string | null;
  source_domain: string | null;
  canonical_url: string | null;
  claim_scope: string | null;
  claim_scope_key: string | null;
  source_platform: string | null;
  claim_status: ClaimStatus;
  verification_method: string | null;
  proof_method: string | null;
  proof_status: ProofStatus | null;
  proof_nonce: string | null;
  proof_error: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
};

type ProfileResponse = {
  walletAddress: string | null;
  claims: CreatorClaim[];
  error?: string;
};

type VerifyResponse = {
  ok?: boolean;
  proof_status?: string;
  error?: string;
  message?: string;
  proof_url?: string;
};

function deriveDomain(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

function statusLabel(status?: ClaimStatus): string {
  if (!status) return "Not submitted";
  if (status === "unclaimed") return "Pending verification";
  if (status === "verified") return "Verified";
  if (status === "rejected") return "Rejected";
  if (status === "revoked") return "Revoked";
  return "Not submitted";
}

function proofStatusLabel(status?: ProofStatus | null): string {
  if (!status || status === "not_started") return "Not started";
  if (status === "pending") return "Awaiting verification";
  if (status === "verified") return "Proof verified";
  if (status === "failed") return "Proof failed";
  if (status === "manual_required") return "Manual review required";
  return "Unknown";
}

function statusStyle(status?: ClaimStatus): React.CSSProperties {
  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: 999,
    padding: "6px 10px",
    fontSize: 12,
    fontWeight: 700,
    border: "1px solid var(--border)",
  };
  if (status === "verified") return { ...base, color: "#047857", background: "#ecfdf5", borderColor: "#a7f3d0" };
  if (status === "rejected" || status === "revoked") return { ...base, color: "#b91c1c", background: "#fef2f2", borderColor: "#fecaca" };
  if (status === "unclaimed") return { ...base, color: "#92400e", background: "#fffbeb", borderColor: "#fde68a" };
  return { ...base, color: "var(--muted)", background: "var(--surface)" };
}

function proofStatusStyle(status?: ProofStatus | null): React.CSSProperties {
  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: 999,
    padding: "4px 8px",
    fontSize: 11,
    fontWeight: 600,
    border: "1px solid var(--border)",
  };
  if (status === "verified") return { ...base, color: "#047857", background: "#ecfdf5", borderColor: "#a7f3d0" };
  if (status === "failed") return { ...base, color: "#b91c1c", background: "#fef2f2", borderColor: "#fecaca" };
  if (status === "pending") return { ...base, color: "#92400e", background: "#fffbeb", borderColor: "#fde68a" };
  if (status === "manual_required") return { ...base, color: "#6b7280", background: "#f3f4f6", borderColor: "#d1d5db" };
  return { ...base, color: "var(--muted)", background: "var(--surface)" };
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function platformLabel(platform?: string | null): string {
  if (!platform) return "Website";
  if (platform === "github") return "GitHub Repository";
  if (platform === "github_pages") return "GitHub Pages";
  if (platform === "vercel") return "Vercel";
  if (platform === "netlify") return "Netlify";
  if (platform === "rss_publisher") return "RSS Publisher";
  if (platform === "twitter") return "X / Twitter";
  if (platform === "youtube") return "YouTube";
  if (platform === "medium") return "Medium";
  if (platform === "substack") return "Substack";
  return "Website";
}

function scopeLabel(claim?: CreatorClaim | null): string {
  if (!claim) return "";
  if (claim.claim_scope === "github_repo") return "GitHub repo-level";
  if (claim.claim_scope === "domain") return "Domain-level";
  if (claim.claim_scope === "host") return "Host-level";
  if (claim.claim_scope === "exact_url") return "Exact URL";
  return claim.claim_scope || "";
}

export default function CreatorProfileClient() {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [claims, setClaims] = useState<CreatorClaim[]>([]);
  const [creatorName, setCreatorName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proofUrl, setProofUrl] = useState<string | null>(null);

  const sourceDomain = useMemo(() => deriveDomain(sourceUrl), [sourceUrl]);
  const currentClaim = claims[0];
  const isVerified = currentClaim?.claim_status === "verified";
  const isPending = currentClaim?.claim_status === "unclaimed" && currentClaim?.proof_status === "pending";

  async function loadProfile() {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/paylabs/creator-profile", { credentials: "include" });
      const data = (await resp.json().catch(() => ({}))) as ProfileResponse;
      if (!resp.ok) {
        setWalletAddress(null);
        setClaims([]);
        return;
      }
      setWalletAddress(data.walletAddress);
      setClaims(data.claims ?? []);
      const firstClaim = data.claims?.[0];
      if (firstClaim) {
        setCreatorName(firstClaim.creator_name ?? "");
        setSourceUrl(firstClaim.source_url ?? "");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load creator profile.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadProfile();
  }, []);

  // Derive proof URL for hosted_link_backlink claims
  useEffect(() => {
    if (currentClaim?.proof_method === "hosted_link_backlink" && currentClaim?.proof_nonce && currentClaim?.id) {
      const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || window.location.origin).replace(/\/+$/, "");
      setProofUrl(`${baseUrl}/creator-proof/${currentClaim.id}/${currentClaim.proof_nonce}`);
    }
  }, [currentClaim?.proof_method, currentClaim?.proof_nonce, currentClaim?.id]);

  async function submitClaim(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const resp = await fetch("/api/paylabs/creator-profile", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creator_name: creatorName, source_url: sourceUrl }),
      });
      const data = (await resp.json().catch(() => ({}))) as ProfileResponse & { claim?: CreatorClaim };
      if (!resp.ok) {
        setError(data.error ?? "Unable to submit creator claim.");
        return;
      }
      setWalletAddress(data.walletAddress);
      setClaims(data.claim ? [data.claim, ...claims.filter((claim) => claim.id !== data.claim?.id)] : data.claims ?? claims);
      setMessage("Source registered. Complete verification to start receiving payouts.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to submit creator claim.");
    } finally {
      setSubmitting(false);
    }
  }

  async function verifyProof() {
    if (!currentClaim) return;
    setVerifying(true);
    setError(null);
    setMessage(null);
    try {
      const resp = await fetch("/api/paylabs/creator-verify", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim_id: currentClaim.id }),
      });
      const data = (await resp.json().catch(() => ({}))) as VerifyResponse;
      if (!resp.ok) {
        setError(data.error ?? data.message ?? "Verification failed.");
        if (data.proof_url) setProofUrl(data.proof_url);
        return;
      }
      setMessage(data.message ?? "Verification completed.");
      if (data.proof_url) setProofUrl(data.proof_url);
      await loadProfile();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification request failed.");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* Step 1: Wallet */}
      <section className="card" style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: "var(--muted)" }}>1</div>
          <div style={{ display: "grid", gap: 6 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700 }}>Creator Wallet</h2>
            {loading ? (
              <p className="muted" style={{ fontSize: 13 }}>Checking creator wallet session…</p>
            ) : walletAddress ? (
              <p style={{ fontSize: 14 }}>Connected UCW creator wallet: <strong>{shortAddress(walletAddress)}</strong></p>
            ) : (
              <p className="muted" style={{ fontSize: 14 }}>
                Connect your Creator Wallet first from <a href="/creator-dashboard" style={{ fontWeight: 700 }}>Creator Dashboard</a>.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* Step 2: Claim Source */}
      <section className="card" style={{ display: "grid", gap: 12, opacity: walletAddress ? 1 : 0.62 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: "var(--muted)" }}>2</div>
          <div style={{ display: "grid", gap: 12, width: "100%" }}>
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 700 }}>Claim Source</h2>
              <p className="muted" style={{ fontSize: 13 }}>Register the HTTPS source that should be attributed to your creator wallet.</p>
            </div>
            <form onSubmit={submitClaim} style={{ display: "grid", gap: 12 }}>
              <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 600 }}>
                Creator name
                <input
                  value={creatorName}
                  onChange={(event) => setCreatorName(event.target.value)}
                  disabled={!walletAddress || submitting}
                  placeholder="Your creator or publication name"
                  style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px", font: "inherit" }}
                />
              </label>
              <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 600 }}>
                Source URL
                <input
                  value={sourceUrl}
                  onChange={(event) => setSourceUrl(event.target.value)}
                  disabled={!walletAddress || submitting}
                  placeholder="https://example.com"
                  style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px", font: "inherit" }}
                />
              </label>
              <div className="muted" style={{ fontSize: 13 }}>
                Source domain preview: <strong>{sourceDomain || "Enter a valid HTTPS source URL"}</strong>
              </div>
              <button className="pl-primary-v3" type="submit" disabled={!walletAddress || submitting}>
                {submitting ? "Submitting…" : "Register source"}
              </button>
            </form>
            {message ? <p style={{ color: "#047857", fontSize: 13, fontWeight: 600 }}>{message}</p> : null}
            {error ? <p style={{ color: "#b91c1c", fontSize: 13, fontWeight: 600 }}>{error}</p> : null}
          </div>
        </div>
      </section>

      {/* Step 3: Verification */}
      {currentClaim && !isVerified && (
        <section className="card" style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: "var(--muted)" }}>3</div>
            <div style={{ display: "grid", gap: 12, width: "100%" }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 700 }}>Verify Ownership</h2>
                <p className="muted" style={{ fontSize: 13 }}>
                  {currentClaim.proof_method === "github_repo_file"
                    ? <>Add a <code>paylabs.json</code> file to your GitHub repository root with your wallet address, then click Verify.</>
                    : <>Add a <code>.well-known/paylabs-verify.json</code> file to your domain with your wallet address, then click Verify.</>
                  }
                </p>
              </div>

              {/* Proof instructions */}
              {currentClaim.proof_method === "github_repo_file" && currentClaim.source_url && (
                <div style={{ background: "var(--surface)", borderRadius: 10, padding: "12px 16px", fontSize: 13, fontFamily: "monospace", lineHeight: 1.6 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>Create this file at:</div>
                  <div style={{ color: "#2563eb", marginBottom: 12 }}>
                    https://raw.githubusercontent.com/{new URL(currentClaim.source_url).pathname.split("/").slice(1, 3).join("/")}/main/paylabs.json
                  </div>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>Contents:</div>
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify({ creator_wallet: walletAddress, creator_name: currentClaim.creator_name }, null, 2)}</pre>
                </div>
              )}

              {currentClaim.proof_method === "well_known_json" && currentClaim.source_domain && (
                <div style={{ background: "var(--surface)", borderRadius: 10, padding: "12px 16px", fontSize: 13, fontFamily: "monospace", lineHeight: 1.6 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>Host this file at:</div>
                  <div style={{ color: "#2563eb", marginBottom: 12 }}>
                    https://{currentClaim.source_domain}/.well-known/paylabs-verify.json
                  </div>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>Contents:</div>
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify({ creator_wallet: walletAddress, creator_name: currentClaim.creator_name, nonce: currentClaim.proof_nonce }, null, 2)}</pre>
                </div>
              )}

              {currentClaim.proof_method === "hosted_link_backlink" && (
                <div style={{ background: "var(--surface)", borderRadius: 10, padding: "12px 16px", fontSize: 13, lineHeight: 1.6 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>Add this verification link to your public profile, bio, or page:</div>
                  <div style={{ background: "var(--bg, #0a0a0a)", borderRadius: 8, padding: "10px 12px", fontFamily: "monospace", fontSize: 12, wordBreak: "break-all", color: "#2563eb", marginBottom: 12 }}>
                    {proofUrl || `Loading verification URL...`}
                  </div>
                  <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                    Paste this link into your public profile bio, README, about page, or any public page at <strong>{currentClaim.source_domain}</strong>.
                    Then click Verify to confirm ownership.
                  </p>
                </div>
              )}

              {currentClaim.proof_method === "manual_review" && (
                <div style={{ background: "var(--surface)", borderRadius: 10, padding: "12px 16px", fontSize: 13 }}>
                  <p className="muted" style={{ margin: 0 }}>Your source requires manual review. Our team will verify your claim and update the status.</p>
                </div>
              )}

              {/* Proof status */}
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Proof status:</span>
                <span style={proofStatusStyle(currentClaim.proof_status)}>{proofStatusLabel(currentClaim.proof_status)}</span>
              </div>

              {currentClaim.proof_error && (
                <p style={{ color: "#b91c1c", fontSize: 13 }}>{currentClaim.proof_error}</p>
              )}

              {/* Verify button */}
              {currentClaim.proof_method !== "manual_review" && (
                <button
                  className="pl-primary-v3"
                  onClick={verifyProof}
                  disabled={verifying || !walletAddress}
                  style={{ justifySelf: "start" }}
                >
                  {verifying ? "Verifying…" : "Verify now"}
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Step 4: Status */}
      <section className="card" style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: "var(--muted)" }}>{currentClaim && !isVerified ? "4" : "3"}</div>
          <div style={{ display: "grid", gap: 8 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700 }}>Verification Status</h2>
            <span style={statusStyle(currentClaim?.claim_status)}>{statusLabel(currentClaim?.claim_status)}</span>
            {currentClaim && (
              <div className="muted" style={{ fontSize: 12, display: "grid", gap: 4 }}>
                {currentClaim.claim_scope && <div>Scope: <strong>{scopeLabel(currentClaim)}</strong></div>}
                {currentClaim.source_platform && <div>Platform: <strong>{platformLabel(currentClaim.source_platform)}</strong></div>}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Step 5: Monetization */}
      <section className="card" style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: "var(--muted)" }}>{currentClaim && !isVerified ? "5" : "4"}</div>
          <div style={{ display: "grid", gap: 6 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700 }}>Monetization Readiness</h2>
            <p className="muted" style={{ fontSize: 14 }}>
              {isVerified
                ? "This source is eligible for PayLabs creator payouts. When AI uses your content, you get paid automatically."
                : "Verified sources can receive creator payouts when used in eligible PayLabs runs."}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
