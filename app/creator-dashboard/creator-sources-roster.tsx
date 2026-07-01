"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

type SourcesResponse = {
  walletAddress: string | null;
  sources: CreatorSource[];
  error?: string;
};

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

function scopeLabel(scope?: string | null): string {
  if (!scope) return "";
  if (scope === "github_repo") return "GitHub repo";
  if (scope === "platform_profile") return "Platform profile";
  if (scope === "domain") return "Domain";
  if (scope === "host") return "Host";
  if (scope === "exact_url") return "Exact URL";
  return scope;
}

function monetizationBadge(status: string): { label: string; color: string; bg: string; border: string } {
  if (status === "indexed_monetized") return { label: "Active", color: "#047857", bg: "#ecfdf5", border: "#a7f3d0" };
  if (status === "verified_awaiting_ingestion") return { label: "Verified, awaiting sync", color: "#0369a1", bg: "#f0f9ff", border: "#bae6fd" };
  if (status === "pending_verification") return { label: "Pending verification", color: "#92400e", bg: "#fffbeb", border: "#fde68a" };
  return { label: "Inactive", color: "#6b7280", bg: "#f3f4f6", border: "#d1d5db" };
}

function statusBadge(status: string): { label: string; color: string; bg: string; border: string } {
  if (status === "verified") return { label: "Verified", color: "#047857", bg: "#ecfdf5", border: "#a7f3d0" };
  if (status === "unclaimed") return { label: "Pending", color: "#92400e", bg: "#fffbeb", border: "#fde68a" };
  if (status === "rejected") return { label: "Rejected", color: "#b91c1c", bg: "#fef2f2", border: "#fecaca" };
  if (status === "revoked") return { label: "Revoked", color: "#b91c1c", bg: "#fef2f2", border: "#fecaca" };
  return { label: status, color: "var(--muted)", bg: "var(--surface)", border: "var(--border)" };
}

export default function CreatorSourcesRoster() {
  const [sources, setSources] = useState<CreatorSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/paylabs/creator-sources", { credentials: "include" });
      const data = (await resp.json().catch(() => ({}))) as SourcesResponse;
      if (!mountedRef.current) return;
      if (!resp.ok) {
        setError(data.error ?? "Failed to load sources.");
        setSources([]);
        return;
      }
      setSources(data.sources ?? []);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : "Failed to load sources.");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    load();
    return () => { mountedRef.current = false; };
  }, [load]);

  // Refetch on tab focus / visibility change
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === "visible") load();
    }
    window.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    return () => {
      window.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
    };
  }, [load]);

  if (loading) {
    return <p className="muted" style={{ fontSize: 13 }}>Loading your registered sources…</p>;
  }

  if (error) {
    return <p style={{ color: "#b91c1c", fontSize: 13, fontWeight: 600 }}>{error}</p>;
  }

  if (sources.length === 0) {
    return (
      <p className="muted" style={{ fontSize: 13 }}>
        No sources registered yet.{" "}
        <a href="/creator-profile" style={{ fontWeight: 600 }}>Register your first source →</a>
      </p>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={load}
          style={{
            fontSize: 12, fontWeight: 600, color: "#2563eb",
            background: "none", border: "1px solid var(--border)",
            borderRadius: 8, padding: "4px 12px", cursor: "pointer",
          }}
        >
          Refresh sources
        </button>
      </div>
      {sources.map((src) => {
        const monetization = monetizationBadge(src.monetization_status);
        const status = statusBadge(src.claim_status);
        return (
          <div
            key={src.id}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "12px 16px",
              display: "grid",
              gap: 8,
              fontSize: 13,
            }}
          >
            {/* Source URL + Platform */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <a
                href={src.source_url ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontWeight: 700, fontSize: 14, color: "var(--fg)", textDecoration: "none", wordBreak: "break-all" }}
              >
                {src.source_url ?? "(unknown)"}
              </a>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>{platformLabel(src.source_platform)}</span>
            </div>

            {/* Creator name + Scope */}
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, color: "var(--muted)" }}>
              {src.creator_name && <span>{src.creator_name}</span>}
              {src.claim_scope && <span>Scope: {scopeLabel(src.claim_scope)}</span>}
            </div>

            {/* Badges row */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{
                display: "inline-flex", alignItems: "center", borderRadius: 999,
                padding: "4px 10px", fontSize: 11, fontWeight: 700,
                color: status.color, background: status.bg, border: `1px solid ${status.border}`,
              }}>
                {status.label}
              </span>
              <span style={{
                display: "inline-flex", alignItems: "center", borderRadius: 999,
                padding: "4px 10px", fontSize: 11, fontWeight: 700,
                color: monetization.color, background: monetization.bg, border: `1px solid ${monetization.border}`,
              }}>
                {monetization.label}
              </span>
              {src.feed_items_count > 0 && (
                <span style={{ fontSize: 11, color: "var(--muted)" }}>
                  {src.feed_items_count} feed item{src.feed_items_count !== 1 ? "s" : ""} indexed
                </span>
              )}
            </div>

            {/* CTA */}
            {src.monetization_status === "pending_verification" && (
              <a
                href={`/creator-profile?claimId=${src.id}`}
                style={{ fontSize: 12, fontWeight: 600, color: "#2563eb", textDecoration: "none" }}
              >
                Verify ownership →
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
