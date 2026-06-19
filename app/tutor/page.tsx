"use client";
import { useState, useEffect } from "react";
import { short } from "@/lib/utils";

interface ProposedSource {
  id: string;
  title: string;
  price_usdc: number;
  reason: string;
  source_ok?: boolean;
  route_ok?: boolean;
  verification_reason?: string;
}

interface RouteOption {
  tier: string;
  label: string;
  maxSources: number;
  description: string;
}

const ROUTE_OPTIONS: RouteOption[] = [
  { tier: "normal", label: "Easy", maxSources: 2, description: "Up to 2 source cards — cheapest and fastest" },
  { tier: "advanced", label: "Normal", maxSources: 5, description: "Up to 5 source cards — balanced path" },
  { tier: "premium", label: "Advanced", maxSources: 8, description: "Up to 8 source cards — deep research path" },
];

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
  const [selectedRoute, setSelectedRoute] = useState("normal");
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatResult, setChatResult] = useState<{
    assistant_message: string;
    normalized_goal: string;
    recommended_route_tier: string;
    route_label: string;
    suggested_budget_usdc: number;
    confidence: number;
    needs_clarification: boolean;
    clarification_question: string | null;
    reasoning: string;
  } | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [path, setPath] = useState<ProposedSource[] | null>(null);
  const [sourcePathId, setSourcePathId] = useState<string | null>(null);
  const [pathStatus, setPathStatus] = useState<string>("none");
  const [routeTier, setRouteTier] = useState<string>("normal");
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [approving, setApproving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [wallet, setWallet] = useState<string | null>(null);
  const [payingSourceId, setPayingSourceId] = useState<string | null>(null);
  const [paidIds, setPaidIds] = useState<Set<string>>(new Set());

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
      setStatusMsg("Install MetaMask or another EVM wallet");
      return;
    }
    try {
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      if (accounts?.length > 0) setWallet(accounts[0]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusMsg("Error: " + msg);
    }
  }

  // ─── Ask Tutor Agent (FREE) ──────────────────────────────────

  async function askTutorAgent() {
    if (!chatInput.trim()) return;
    setChatLoading(true);
    setChatResult(null);
    setChatError(null);
    try {
      const res = await fetch("/api/paylabs/tutor/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: chatInput.trim(),
          wallet: wallet || undefined,
          current_goal: goal || undefined,
          current_budget_usdc: budget ? parseFloat(budget) : undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setChatResult(data);
      } else {
        setChatError(data.error || "Failed to get recommendation");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setChatError("Error: " + msg);
    }
    setChatLoading(false);
  }

  function useRecommendation() {
    if (!chatResult) return;
    if (chatResult.needs_clarification) return;
    if (chatResult.normalized_goal) setGoal(chatResult.normalized_goal);
    if (chatResult.recommended_route_tier) setSelectedRoute(chatResult.recommended_route_tier);
    if (chatResult.suggested_budget_usdc) setBudget(chatResult.suggested_budget_usdc.toString());
  }

  // ─── Propose Source Path ────────────────────────────────────

  async function proposeSourcePath() {
    if (!wallet) { setStatusMsg("Connect wallet first"); return; }
    setLoading(true);
    setPath(null);
    setSourcePathId(null);
    setPathStatus("none");
    setStatusMsg("");
    setPaidIds(new Set());

    try {
      const res = await fetch("/api/paylabs/source-paths/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal, budget_usdc: parseFloat(budget), user_wallet: wallet, route_tier: selectedRoute }),
      });
      const data = await res.json();
      if (data.path) {
        setPath(data.path);
        setSourcePathId(data.source_path_id || null);
        setPathStatus(data.source_path_status || "none");
        setRouteTier(data.route_tier || selectedRoute);
        setTotal(data.total_usdc);
      } else {
        setStatusMsg("Error: " + (data.error || "Could not propose source path"));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusMsg("Error: " + msg);
    }
    setLoading(false);
  }

  async function approvePath() {
    if (!sourcePathId || !wallet) return;
    setApproving(true);
    setStatusMsg("");
    try {
      const res = await fetch(`/api/paylabs/source-paths/${sourcePathId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_wallet: wallet }),
      });
      const data = await res.json();
      if (res.ok) {
        setPathStatus(data.source_path_status || "approved");
        setStatusMsg("Source path approved. You can now pay for sources.");
      } else {
        setStatusMsg("Error: " + (data.error || "Approval failed"));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusMsg("Error: " + msg);
    }
    setApproving(false);
  }

  async function payForSource(sourceId: string) {
    if (!wallet) { setStatusMsg("Connect wallet first"); return; }
    if (!sourcePathId) { setStatusMsg("Error: No source_path_id. Propose and approve first."); return; }
    if (pathStatus !== "approved") { setStatusMsg("Error: Path must be approved before paying."); return; }
    setPayingSourceId(sourceId);
    setStatusMsg("Paying via ArcLayer Runner...");
    try {
      const res = await fetch("/api/paylabs/source-payments/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_wallet: wallet, source_path_id: sourcePathId, source_path_item_id: sourceId }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setStatusMsg(`Paid! Payment: ${data.source_payment_id || "pending settlement"}`);
        setPaidIds((prev) => new Set([...prev, sourceId]));
      } else {
        setStatusMsg("Error: " + (data.reason || data.error));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatusMsg("Error: " + msg);
    }
    setPayingSourceId(null);
  }

  // ─── Derived state ──────────────────────────────────────────

  const isApproved = pathStatus === "approved";
  const isProposed = pathStatus === "proposed";
  const canUseRecommendation = chatResult && !chatResult.needs_clarification;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div>
        <h1 className="page-title">AI Tutor</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          Chat, propose source path, approve, pay per source citation.
        </p>
      </div>

      {/* Wallet */}
      <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {wallet ? (
          <span style={{ fontSize: 14 }}>
            <span style={{ color: "var(--success)", fontWeight: 600 }}>Connected</span>{" "}
            <span className="data-mono">{wallet.slice(0, 6)}…{wallet.slice(-4)}</span>
          </span>
        ) : (
          <button onClick={connectWallet} className="btn btn-primary">Connect Wallet</button>
        )}
      </div>

      {/* Step 1: Ask */}
      <section className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <span style={{
            width: 24, height: 24, borderRadius: "50%", background: "var(--foreground)",
            color: "white", display: "inline-flex", alignItems: "center", justifyContent: "center",
            fontSize: 12, fontWeight: 700, flexShrink: 0,
          }}>1</span>
          <span style={{ fontWeight: 700, fontSize: 15 }}>Ask</span>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            className="input"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder='e.g. "I want to build an x402 paying agent on Arc"'
            onKeyDown={(e) => { if (e.key === "Enter" && !chatLoading) askTutorAgent(); }}
            style={{ flex: 1 }}
          />
          <button onClick={askTutorAgent} disabled={chatLoading || !chatInput.trim()} className="btn btn-primary" style={{ whiteSpace: "nowrap" }}>
            {chatLoading ? "Thinking…" : "Ask"}
          </button>
        </div>

        {chatError && (
          <div style={{ padding: "10px 12px", background: "var(--danger-soft)", borderRadius: 8, fontSize: 13, color: "var(--danger)", marginBottom: 12 }}>
            {chatError}
          </div>
        )}

        {chatResult && (
          <div style={{ padding: 16, background: chatResult.needs_clarification ? "var(--warning-soft)" : "var(--success-soft)", borderRadius: 10, border: `1px solid ${chatResult.needs_clarification ? "var(--warning)" : "var(--success)"}20` }}>
            {!chatResult.needs_clarification && (
              <span className="badge badge-success" style={{ marginBottom: 8 }}>
                {chatResult.route_label}
              </span>
            )}

            <div style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 8 }}>
              {chatResult.assistant_message}
            </div>

            {!chatResult.needs_clarification && (
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                Goal: {chatResult.normalized_goal} · Budget: {chatResult.suggested_budget_usdc} USDC · Confidence: {Math.round(chatResult.confidence * 100)}%
              </div>
            )}

            {chatResult.needs_clarification && chatResult.clarification_question && (
              <div style={{ fontSize: 13, color: "var(--warning)", fontWeight: 500, marginBottom: 8 }}>
                {chatResult.clarification_question}
              </div>
            )}

            {/* Use recommendation */}
            {!chatResult.needs_clarification && canUseRecommendation && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button onClick={useRecommendation} className="btn btn-green" style={{ fontSize: 13 }}>
                  Use Recommendation
                </button>
                <span className="muted" style={{ fontSize: 12 }}>
                  Click Propose Source Path next.
                </span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Step 2: Route selector */}
      <section className="card-soft">
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>Route override</div>
        <div className="grid-3">
          {ROUTE_OPTIONS.map((route) => (
            <button
              key={route.tier}
              onClick={() => setSelectedRoute(route.tier)}
              style={{
                padding: "12px 14px",
                borderRadius: 10,
                border: `2px solid ${selectedRoute === route.tier ? "var(--foreground)" : "var(--border)"}`,
                background: selectedRoute === route.tier ? "var(--accent-soft)" : "white",
                cursor: "pointer",
                textAlign: "left",
                transition: "all 0.15s",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 14 }}>{route.label}</div>
              <div className="muted" style={{ fontSize: 12 }}>{route.description}</div>
            </button>
          ))}
        </div>
      </section>

      {/* Step 3: Propose source path */}
      <section className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <span style={{
            width: 24, height: 24, borderRadius: "50%", background: "var(--foreground)",
            color: "white", display: "inline-flex", alignItems: "center", justifyContent: "center",
            fontSize: 12, fontWeight: 700, flexShrink: 0,
          }}>3</span>
          <span style={{ fontWeight: 700, fontSize: 15 }}>Propose source path</span>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <div>
            <label className="muted" style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Goal</label>
            <input className="input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. Learn x402 nanopayments on Arc" />
          </div>
          <div>
            <label className="muted" style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Budget (USDC)</label>
            <input className="input" type="number" step="0.001" value={budget} onChange={(e) => setBudget(e.target.value)} style={{ maxWidth: 160 }} />
          </div>
          <button onClick={proposeSourcePath} disabled={loading || !goal || !wallet} className="btn btn-primary">
            {loading ? "Running workflow…" : `Propose ${ROUTE_OPTIONS.find(r => r.tier === selectedRoute)?.label || "Path"}`}
          </button>
        </div>
      </section>

      {/* Proposed Source Path */}
      {path && (
        <section className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <h2 className="section-title" style={{ margin: 0 }}>
              Proposed Source Path
              {sourcePathId && <span className="muted data-mono" style={{ fontSize: 12, marginLeft: 8 }}>{short(sourcePathId)}</span>}
            </h2>
            <span className="data-mono" style={{ fontWeight: 700, fontSize: 15 }}>{total.toFixed(6)} USDC</span>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
            <span className="badge badge-success">{routeTier}</span>
            <span className={`badge ${isApproved ? "badge-success" : isProposed ? "badge-warning" : "badge-neutral"}`}>
              {pathStatus}
            </span>
          </div>

          {isProposed && (
            <button onClick={approvePath} disabled={approving} className="btn btn-primary" style={{ marginBottom: 16 }}>
              {approving ? "Approving…" : "Approve Budget"}
            </button>
          )}

          <div style={{ display: "grid", gap: 8 }}>
            {path.map((s: ProposedSource, i: number) => (
              <div
                key={s.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "12px 14px",
                  background: paidIds.has(s.id) ? "var(--success-soft)" : "var(--card-soft)",
                  borderRadius: 10,
                  border: `1px solid ${paidIds.has(s.id) ? "var(--success)30" : "var(--border)"}`,
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {i + 1}. {s.title || "Untitled source"}
                    {paidIds.has(s.id) && <span style={{ color: "var(--success)", marginLeft: 8, fontSize: 12 }}>✓ Paid</span>}
                  </div>
                  {s.verification_reason && (
                    <div style={{ fontSize: 12, color: "var(--success)", marginTop: 2 }}>✓ {s.verification_reason}</div>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className="data-mono" style={{ fontWeight: 700, color: "var(--success)" }}>{s.price_usdc} USDC</span>
                  {!paidIds.has(s.id) && (
                    <button
                      onClick={() => payForSource(s.id)}
                      disabled={!isApproved || payingSourceId === s.id}
                      className="btn btn-green"
                      style={{ fontSize: 13, opacity: isApproved ? 1 : 0.4 }}
                    >
                      {payingSourceId === s.id ? "Paying…" : isApproved ? "Pay" : "Approve first"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {statusMsg && (
            <p style={{ marginTop: 12, fontSize: 13, color: statusMsg.startsWith("Error") ? "var(--danger)" : "var(--success)" }}>
              {statusMsg}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
