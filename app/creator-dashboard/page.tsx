"use client";

import { useCallback, useEffect, useState } from "react";
import CreatorSourcesRoster from "./creator-sources-roster";
import PageHeader from "@/components/paylabs/PageHeader";

function shortAddr(addr?: string | null) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function CreatorPage() {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  const checkSession = useCallback(async () => {
    try {
      const resp = await fetch("/api/paylabs/wallet/ucw?action=session-restore", {
        method: "POST",
        credentials: "include",
      });
      if (!resp.ok) { setWalletAddress(null); return; }
      const data = await resp.json().catch(() => ({}));
      setWalletAddress(data?.walletAddress ?? null);
    } catch {
      setWalletAddress(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { checkSession(); }, [checkSession]);

  return (
    <>
      <PageHeader />
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <a href="/" style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>← Chat</a>
        <h1 className="page-title">Creator Dashboard</h1>
      </div>

      {/* Creator Profile CTA / summary */}
      <div className="pl-creator-cta-card">
        <h2>Creator Profile</h2>
        {checking ? (
          <p>Checking wallet session…</p>
        ) : walletAddress ? (
          <>
            <p>
              Creator Wallet connected: <strong>{shortAddr(walletAddress)}</strong>
            </p>
            <a className="pl-creator-cta-link" href="/creator-profile">
              Manage Creator Profile →
            </a>
          </>
        ) : (
          <>
            <p>
              Set up your Creator Profile to connect your Creator Wallet and register sources.
            </p>
            <a className="pl-creator-cta-link" href="/creator-profile">
              Set up Creator Profile →
            </a>
          </>
        )}
      </div>

      <div className="card" style={{ display: "grid", gap: 12 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>Registered Sources</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          Sources you have registered and their verification / monetization status.
        </p>
        <CreatorSourcesRoster />
      </div>

      <div className="card" style={{ textAlign: "center", padding: "64px 24px" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🔒</div>
        <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Earnings Dashboard</h2>
        <p className="muted" style={{ fontSize: 14, maxWidth: 400, margin: "0 auto" }}>
          Creator earnings tracking is under development. Set up your Creator Profile to get started.
        </p>
      </div>
    </div>
    </>
  );
}
