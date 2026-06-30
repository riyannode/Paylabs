"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type ClaimStatus = "unclaimed" | "verified" | "rejected" | "revoked" | "unknown";

type CreatorClaim = {
  id: string;
  creator_wallet: string;
  creator_name: string | null;
  source_url: string | null;
  source_domain: string | null;
  claim_status: ClaimStatus;
  verification_method: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
  proof_type: string | null;
  proof_nonce: string | null;
  proof_status: string;
  proof_checked_at: string | null;
  proof_error: string | null;
};

type ProfileResponse = {
  walletAddress: string | null;
  claims: CreatorClaim[];
  error?: string;
};

type ProofCheckResponse = {
  ok: boolean;
  verified?: boolean;
  already_verified?: boolean;
  proof_error?: string | null;
  claim?: CreatorClaim;
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
  if (status === "unclaimed") return "Pending proof";
  if (status === "verified") return "Verified";
  if (status === "rejected") return "Rejected";
  if (status === "revoked") return "Revoked";
  return "Not submitted";
}

function statusBadgeClass(status?: ClaimStatus): string {
  if (status === "verified") return "badge badge-success";
  if (status === "rejected" || status === "revoked") return "badge badge-danger";
  if (status === "unclaimed") return "badge badge-warning";
  return "badge badge-neutral";
}

function proofStatusBadge(proofStatus: string): { label: string; cls: string } {
  if (proofStatus === "verified") return { label: "Proof verified", cls: "badge badge-success" };
  if (proofStatus === "failed") return { label: "Proof failed", cls: "badge badge-danger" };
  if (proofStatus === "pending") return { label: "Waiting for proof", cls: "badge badge-warning" };
  return { label: "Not started", cls: "badge badge-neutral" };
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function CreatorProfileClient() {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [claims, setClaims] = useState<CreatorClaim[]>([]);
  const [creatorName, setCreatorName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Proof check state per claim
  const [checkingProof, setCheckingProof] = useState<Record<string, boolean>>({});
  const [proofResult, setProofResult] = useState<Record<string, { ok: boolean; msg: string }>>({});

  const sourceDomain = useMemo(() => deriveDomain(sourceUrl), [sourceUrl]);
  const currentClaim = claims[0];
  const isVerified = currentClaim?.claim_status === "verified";

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
      setMessage("Source submitted. Publish your proof below, then check verification.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to submit creator claim.");
    } finally {
      setSubmitting(false);
    }
  }

  const checkProof = useCallback(
    async (claimId: string, proofType: "well_known_json" | "dns_txt") => {
      setCheckingProof((prev) => ({ ...prev, [claimId]: true }));
      setProofResult((prev) => {
        const next = { ...prev };
        delete next[claimId];
        return next;
      });
      try {
        const resp = await fetch("/api/paylabs/creator-profile/proof", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ claim_id: claimId, proof_type: proofType }),
        });
        const data = (await resp.json().catch(() => ({}))) as ProofCheckResponse;

        if (data.claim) {
          setClaims((prev) => prev.map((c) => (c.id === claimId ? data.claim! : c)));
        }

        if (data.ok || data.already_verified) {
          setProofResult((prev) => ({
            ...prev,
            [claimId]: { ok: true, msg: data.already_verified ? "Already verified." : "Verification succeeded!" },
          }));
        } else {
          setProofResult((prev) => ({
            ...prev,
            [claimId]: { ok: false, msg: data.proof_error ?? "Verification failed." },
          }));
        }
      } catch {
        setProofResult((prev) => ({
          ...prev,
          [claimId]: { ok: false, msg: "Network error. Try again." },
        }));
      } finally {
        setCheckingProof((prev) => ({ ...prev, [claimId]: false }));
      }
    },
    [],
  );

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
              <p style={{ fontSize: 14 }}>Connected UCW creator wallet: <strong className="data-mono">{shortAddress(walletAddress)}</strong></p>
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
              <button className="btn btn-primary" type="submit" disabled={!walletAddress || submitting}>
                {submitting ? "Submitting…" : "Submit for verification"}
              </button>
            </form>
            {message ? <p style={{ color: "#047857", fontSize: 13, fontWeight: 600 }}>{message}</p> : null}
            {error ? <p style={{ color: "#b91c1c", fontSize: 13, fontWeight: 600 }}>{error}</p> : null}
          </div>
        </div>
      </section>

      {/* Step 3: Verify Ownership */}
      {currentClaim && currentClaim.claim_status !== "verified" && (
        <section className="card" style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: "var(--muted)" }}>3</div>
            <div style={{ display: "grid", gap: 12, width: "100%" }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 700 }}>Verify Ownership</h2>
                <p className="muted" style={{ fontSize: 13 }}>
                  Publish one proof method, then check verification. Verified sources are eligible for creator payouts when used in PayLabs runs.
                </p>
              </div>

              {/* Proof status badge */}
              {currentClaim.proof_status && currentClaim.proof_status !== "not_started" && (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className={proofStatusBadge(currentClaim.proof_status).cls}>
                    {proofStatusBadge(currentClaim.proof_status).label}
                  </span>
                  {currentClaim.proof_checked_at && (
                    <span className="muted" style={{ fontSize: 12 }}>
                      Last checked: {new Date(currentClaim.proof_checked_at).toLocaleString()}
                    </span>
                  )}
                </div>
              )}

              {/* Pending message */}
              {currentClaim.proof_status === "pending" && (
                <p className="muted" style={{ fontSize: 13 }}>
                  Waiting for proof. DNS and deployment changes may take a few minutes.
                </p>
              )}

              {/* Failed message */}
              {currentClaim.proof_status === "failed" && currentClaim.proof_error && (
                <p style={{ color: "#b91c1c", fontSize: 13 }}>
                  Verification failed: <strong>{currentClaim.proof_error}</strong>. Update the proof and try again.
                </p>
              )}

              {/* Proof result inline */}
              {proofResult[currentClaim.id] && (
                <p style={{ color: proofResult[currentClaim.id].ok ? "#047857" : "#b91c1c", fontSize: 13, fontWeight: 600 }}>
                  {proofResult[currentClaim.id].msg}
                </p>
              )}

              {/* Well-known JSON proof */}
              {currentClaim.proof_nonce && currentClaim.source_domain && (
                <div className="card-soft" style={{ display: "grid", gap: 10, padding: 14 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>Option A: Well-Known JSON</div>
                  <p className="muted" style={{ fontSize: 12 }}>
                    Upload this file to your site:
                  </p>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>
                    URL: <code className="data-mono">https://{currentClaim.source_domain}/.well-known/paylabs-creator.json</code>
                  </div>
                  <pre
                    className="data-mono"
                    style={{
                      fontSize: 12,
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: 12,
                      overflow: "auto",
                      margin: 0,
                    }}
                  >
{`{
  "service": "paylabs",
  "version": 1,
  "claim_id": "${currentClaim.id}",
  "creator_wallet": "${currentClaim.creator_wallet.toLowerCase()}",
  "source_domain": "${currentClaim.source_domain.toLowerCase()}",
  "nonce": "${currentClaim.proof_nonce}"
}`}
                  </pre>
                  <button
                    className="btn btn-secondary"
                    disabled={!!checkingProof[currentClaim.id]}
                    onClick={() => checkProof(currentClaim.id, "well_known_json")}
                  >
                    {checkingProof[currentClaim.id] ? "Checking…" : "Check well-known proof"}
                  </button>
                </div>
              )}

              {/* DNS TXT proof */}
              {currentClaim.proof_nonce && currentClaim.source_domain && (
                <div className="card-soft" style={{ display: "grid", gap: 10, padding: 14 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>Option B: DNS TXT Record</div>
                  <p className="muted" style={{ fontSize: 12 }}>
                    Add this TXT record to your DNS:
                  </p>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>
                    Host: <code className="data-mono">_paylabs.{currentClaim.source_domain}</code>
                  </div>
                  <pre
                    className="data-mono"
                    style={{
                      fontSize: 12,
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: 12,
                      overflow: "auto",
                      margin: 0,
                    }}
                  >
{`paylabs-v1 claim=${currentClaim.id} wallet=${currentClaim.creator_wallet.toLowerCase()} nonce=${currentClaim.proof_nonce}`}
                  </pre>
                  <button
                    className="btn btn-secondary"
                    disabled={!!checkingProof[currentClaim.id]}
                    onClick={() => checkProof(currentClaim.id, "dns_txt")}
                  >
                    {checkingProof[currentClaim.id] ? "Checking…" : "Check DNS proof"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Step 3/4: Status + Monetization */}
      <section className="card" style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: "var(--muted)" }}>{currentClaim && currentClaim.claim_status !== "verified" ? "4" : "3"}</div>
          <div style={{ display: "grid", gap: 8 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700 }}>
              {isVerified ? "Monetization Ready" : "Verification Status"}
            </h2>
            {currentClaim && (
              <span className={statusBadgeClass(currentClaim.claim_status)}>{statusLabel(currentClaim.claim_status)}</span>
            )}
            <p className="muted" style={{ fontSize: 14 }}>
              {isVerified
                ? "This source is verified and eligible for PayLabs creator payouts."
                : "Verified sources can receive creator payouts when used in eligible PayLabs runs."}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
