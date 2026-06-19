"use client";
import { useState, useEffect } from "react";

interface ProposedLesson {
  id: string;
  slug: string;
  title: string;
  price_usdc: number;
  reason: string;
}

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      isMetaMask?: boolean;
    };
  }
}

export default function TutorPage() {
  const [goal, setGoal] = useState("");
  const [budget, setBudget] = useState("0.01");
  const [path, setPath] = useState<ProposedLesson[] | null>(null);
  const [pathId, setPathId] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [buyStatus, setBuyStatus] = useState<string>("");
  const [wallet, setWallet] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && window.ethereum) {
      window.ethereum
        .request({ method: "eth_accounts" })
        .then((accounts: unknown) => {
          const addrs = accounts as string[];
          if (addrs?.length > 0) setWallet(addrs[0]);
        })
        .catch(() => {});
    }
  }, []);

  async function connectWallet() {
    if (!window.ethereum) {
      setBuyStatus("Error: Install MetaMask or another EVM wallet");
      return;
    }
    try {
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      if (accounts?.length > 0) setWallet(accounts[0]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setBuyStatus("Error connecting wallet: " + msg);
    }
  }

  async function proposePath() {
    if (!wallet) {
      setBuyStatus("Connect wallet first");
      return;
    }
    setLoading(true);
    setPath(null);
    setPathId(null);
    setBuyStatus("");
    try {
      const res = await fetch("/api/paylabs/tutor/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal,
          budget_usdc: parseFloat(budget),
          user_wallet: wallet,
        }),
      });
      const data = await res.json();
      if (data.path) {
        setPath(data.path);
        setPathId(data.path_id || null);
        setTotal(data.total_usdc);
      } else {
        setBuyStatus("Error: " + (data.error || "Could not propose path"));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setBuyStatus("Error: " + msg);
    }
    setLoading(false);
  }

  async function buyLesson(lessonId: string) {
    if (!wallet) {
      setBuyStatus("Connect wallet first");
      return;
    }
    setBuyStatus("Buying via ArcLayer Runner...");
    try {
      const res = await fetch("/api/paylabs/agent/buy-lesson", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_wallet: wallet,
          lesson_id: lessonId,
          path_id: pathId,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setBuyStatus(`Unlocked: ${data.unlock_id} (payment: ${data.payment_id || "pending settlement"})`);
      } else {
        setBuyStatus("Error: " + (data.reason || data.error));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setBuyStatus("Error: " + msg);
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: "2rem", fontWeight: 700, marginBottom: "0.5rem" }}>AI Tutor</h1>
      <p style={{ color: "var(--muted)", marginBottom: "2rem" }}>
        Set a goal and budget. The tutor proposes a learning path from real lessons.
        Purchases go through ArcLayer Runner with budget policy enforcement.
      </p>

      {/* Wallet connection */}
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        {wallet ? (
          <div style={{ fontSize: "0.875rem" }}>
            <span style={{ color: "var(--accent-green)" }}>Connected:</span>{" "}
            {wallet.slice(0, 6)}...{wallet.slice(-4)}
          </div>
        ) : (
          <button onClick={connectWallet} className="btn btn-primary">
            Connect Wallet
          </button>
        )}
      </div>

      {/* Goal + budget input */}
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <div style={{ display: "grid", gap: "1rem" }}>
          <div>
            <label style={{ display: "block", fontSize: "0.875rem", color: "var(--muted)", marginBottom: "0.25rem" }}>
              Learning Goal
            </label>
            <input
              className="input"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="e.g. Learn x402 nanopayments and agentic commerce on Arc"
            />
          </div>
          <div>
            <label style={{ display: "block", fontSize: "0.875rem", color: "var(--muted)", marginBottom: "0.25rem" }}>
              Budget (USDC)
            </label>
            <input
              className="input"
              type="number"
              step="0.001"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              style={{ maxWidth: 200 }}
            />
          </div>
          <button onClick={proposePath} disabled={loading || !goal || !wallet} className="btn btn-primary">
            {loading ? "Thinking..." : "Propose Learning Path"}
          </button>
        </div>
      </div>

      {/* Proposed path */}
      {path && (
        <div className="card">
          <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "1rem" }}>
            Proposed Path (Total: {total.toFixed(4)} USDC)
            {pathId && <span style={{ fontSize: "0.75rem", color: "var(--muted)", marginLeft: "0.5rem" }}>ID: {pathId.slice(0, 8)}...</span>}
          </h2>
          <p style={{ fontSize: "0.8rem", color: "var(--muted)", marginBottom: "1rem" }}>
            Purchases enforced by budget policy. All payments go through ArcLayer Runner.
          </p>
          <div style={{ display: "grid", gap: "0.75rem" }}>
            {path.map((l, i) => (
              <div key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.75rem", background: "rgba(255,255,255,0.03)", borderRadius: 8 }}>
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {i + 1}. {l.title}
                  </div>
                  <div style={{ fontSize: "0.8rem", color: "var(--muted)", marginTop: "0.25rem" }}>
                    {l.reason}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                  <span style={{ fontWeight: 700, color: "var(--accent-green)" }}>{l.price_usdc} USDC</span>
                  <button onClick={() => buyLesson(l.id)} className="btn btn-green" style={{ fontSize: "0.8rem" }}>
                    Buy via Runner
                  </button>
                </div>
              </div>
            ))}
          </div>
          {buyStatus && (
            <p style={{ marginTop: "1rem", fontSize: "0.875rem", color: buyStatus.startsWith("Error") ? "#ef4444" : "var(--accent-green)" }}>
              {buyStatus}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
