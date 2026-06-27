"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

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
};

type ProfileResponse = {
  walletAddress: string | null;
  claims: CreatorClaim[];
  error?: string;
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
  if (status === "unclaimed") return "Under review";
  if (status === "verified") return "Verified";
  if (status === "rejected") return "Rejected";
  if (status === "revoked") return "Revoked";
  return "Not submitted";
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
      setMessage("Creator source submitted for manual review.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to submit creator claim.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
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
                {submitting ? "Submitting…" : "Submit for review"}
              </button>
            </form>
            {message ? <p style={{ color: "#047857", fontSize: 13, fontWeight: 600 }}>{message}</p> : null}
            {error ? <p style={{ color: "#b91c1c", fontSize: 13, fontWeight: 600 }}>{error}</p> : null}
          </div>
        </div>
      </section>

      <section className="card" style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: "var(--muted)" }}>3</div>
          <div style={{ display: "grid", gap: 8 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700 }}>Verification Status</h2>
            <span style={statusStyle(currentClaim?.claim_status)}>{statusLabel(currentClaim?.claim_status)}</span>
          </div>
        </div>
      </section>

      <section className="card" style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: "var(--muted)" }}>4</div>
          <div style={{ display: "grid", gap: 6 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700 }}>Monetization Readiness</h2>
            <p className="muted" style={{ fontSize: 14 }}>
              {isVerified
                ? "This source is eligible for PayLabs creator payouts."
                : "Verified sources can receive creator payouts when used in eligible PayLabs runs."}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
