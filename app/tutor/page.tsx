"use client";
import { useState, useEffect } from "react";
import { short } from "@/lib/utils";

interface ProposedLesson {
  id: string;
  slug: string;
  title: string;
  price_usdc: number;
  reason: string;
  source_ok?: boolean;
  creator_ok?: boolean;
  verification_reason?: string;
}

interface RouteOption {
  tier: string;
  label: string;
  maxLessons: number;
  description: string;
}

interface AgentServiceCall {
  id?: string;
  buyer_agent_id?: string;
  provider_agent_id?: string;
  service_type?: string;
  amount_usdc?: number;
  payment_id?: string;
  payment_ref?: string;
  settlement_ref?: string;
  output_hash?: string;
  status?: string;
}

interface RouteTollProof {
  route_toll_call_id: string;
  route_payment_id: string;
  route_payment_ref?: string;
  route_settlement_ref?: string;
  route_input_hash: string;
  route_tier: string;
  route_label: string;
  route_toll_amount_usdc: number;
}

const ROUTE_OPTIONS: RouteOption[] = [
  { tier: "normal", label: "Normal", maxLessons: 2, description: "Up to 2 lessons" },
  { tier: "advanced", label: "Advanced", maxLessons: 5, description: "Up to 5 lessons" },
  { tier: "premium", label: "Premium", maxLessons: 8, description: "Up to 8 lessons" },
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
    learning_level: string;
    suggested_budget_usdc: number;
    confidence: number;
    needs_clarification: boolean;
    clarification_question: string | null;
    reasoning: string;
    route_toll_enabled?: boolean;
    route_toll_required?: boolean;
    route_toll_amount_usdc?: number;
  } | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [routeTollProof, setRouteTollProof] = useState<RouteTollProof | null>(null);
  const [routeTollPaying, setRouteTollPaying] = useState(false);
  const [routeTollError, setRouteTollError] = useState<string | null>(null);
  const [path, setPath] = useState<ProposedLesson[] | null>(null);
  const [pathId, setPathId] = useState<string | null>(null);
  const [pathStatus, setPathStatus] = useState<string>("none");
  const [routeTier, setRouteTier] = useState<string>("normal");
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [approving, setApproving] = useState(false);
  const [buyStatus, setBuyStatus] = useState<string>("");
  const [wallet, setWallet] = useState<string | null>(null);
  const [buyingLessonId, setBuyingLessonId] = useState<string | null>(null);
  const [unlockedIds, setUnlockedIds] = useState<Set<string>>(new Set());
  const [agentServiceCalls, setAgentServiceCalls] = useState<AgentServiceCall[]>([]);

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
      setBuyStatus("Install MetaMask or another EVM wallet");
      return;
    }
    try {
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      if (accounts?.length > 0) setWallet(accounts[0]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setBuyStatus("Error: " + msg);
    }
  }

  // ─── Ask Tutor Agent (FREE) ──────────────────────────────────

  async function askTutorAgent() {
    if (!chatInput.trim()) return;
    setChatLoading(true);
    setChatResult(null);
    setChatError(null);
    setRouteTollProof(null);
    setRouteTollError(null);
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

  // ─── Pay Route Toll ──────────────────────────────────────────

  async function payRouteToll() {
    if (!chatResult || !wallet) return;
    if (!chatResult.route_toll_enabled || !chatResult.route_toll_required) return;
    if (!chatResult.recommended_route_tier) return;

    setRouteTollPaying(true);
    setRouteTollError(null);
    setRouteTollProof(null);

    try {
      const res = await fetch("/api/paylabs/tutor/route-toll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_wallet: wallet,
          route_tier: chatResult.recommended_route_tier,
          route_label: chatResult.route_label,
          normalized_goal: chatResult.normalized_goal,
          user_message: chatInput.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok && data.route_payment_status === "completed") {
        setRouteTollProof(data);
        if (chatResult.normalized_goal) setGoal(chatResult.normalized_goal);
        if (chatResult.recommended_route_tier) setSelectedRoute(chatResult.recommended_route_tier);
        if (chatResult.suggested_budget_usdc) setBudget(chatResult.suggested_budget_usdc.toString());
      } else {
        setRouteTollError(data.error || "Route toll payment failed");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setRouteTollError("Error: " + msg);
    }
    setRouteTollPaying(false);
  }

  function useRecommendation() {
    if (!chatResult) return;
    if (chatResult.needs_clarification) return;
    if (chatResult.normalized_goal) setGoal(chatResult.normalized_goal);
    if (chatResult.recommended_route_tier) setSelectedRoute(chatResult.recommended_route_tier);
    if (chatResult.suggested_budget_usdc) setBudget(chatResult.suggested_budget_usdc.toString());
  }

  // ─── Propose Path ────────────────────────────────────────────

  async function proposePath() {
    if (!wallet) { setBuyStatus("Connect wallet first"); return; }
    setLoading(true);
    setPath(null);
    setPathId(null);
    setPathStatus("none");
    setBuyStatus("");
    setUnlockedIds(new Set());
    setAgentServiceCalls([]);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (routeTollProof) {
      headers["x-route-payment-id"] = routeTollProof.route_payment_id;
      if (routeTollProof.route_payment_ref) headers["x-route-payment-ref"] = routeTollProof.route_payment_ref;
      if (routeTollProof.route_settlement_ref) headers["x-route-settlement-ref"] = routeTollProof.route_settlement_ref;
      headers["x-route-input-hash"] = routeTollProof.route_input_hash;
    }

    try {
      const res = await fetch("/api/paylabs/learning-paths/propose", {
        method: "POST",
        headers,
        body: JSON.stringify({ goal, budget_usdc: parseFloat(budget), user_wallet: wallet, route_tier: selectedRoute }),
      });
      const data = await res.json();
      if (data.path) {
        setPath(data.path);
        setPathId(data.path_id || null);
        setPathStatus(data.path_status || "none");
        setRouteTier(data.route_tier || selectedRoute);
        setTotal(data.total_usdc);
        setAgentServiceCalls(data.agent_service_calls || []);
      } else {
        setBuyStatus("Error: " + (data.error || "Could not propose path"));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setBuyStatus("Error: " + msg);
    }
    setLoading(false);
  }

  async function approvePath() {
    if (!pathId || !wallet) return;
    setApproving(true);
    setBuyStatus("");
    try {
      const res = await fetch(`/api/paylabs/learning-paths/${pathId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_wallet: wallet }),
      });
      const data = await res.json();
      if (res.ok) {
        setPathStatus(data.path_status || "approved");
        setBuyStatus("Path approved. You can now buy lessons.");
      } else {
        setBuyStatus("Error: " + (data.error || "Approval failed"));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setBuyStatus("Error: " + msg);
    }
    setApproving(false);
  }

  async function buyLesson(lessonId: string) {
    if (!wallet) { setBuyStatus("Connect wallet first"); return; }
    if (!pathId) { setBuyStatus("Error: No path_id. Propose and approve first."); return; }
    if (pathStatus !== "approved") { setBuyStatus("Error: Path must be approved before buying."); return; }
    setBuyingLessonId(lessonId);
    setBuyStatus("Buying via ArcLayer Runner...");
    try {
      const res = await fetch("/api/paylabs/agent/buy-lesson", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_wallet: wallet, lesson_id: lessonId, path_id: pathId }),
      });
      const data = await res.json();
      if (res.ok) {
        setBuyStatus(`Unlocked! Payment: ${data.payment_id || "pending settlement"}`);
        setUnlockedIds((prev) => new Set([...prev, lessonId]));
      } else {
        setBuyStatus("Error: " + (data.reason || data.error));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setBuyStatus("Error: " + msg);
    }
    setBuyingLessonId(null);
  }

  // ─── Derived state ──────────────────────────────────────────

  const isApproved = pathStatus === "approved";
  const isProposed = pathStatus === "proposed";
  const tollNeeded = chatResult?.route_toll_enabled && chatResult?.route_toll_required && !chatResult?.needs_clarification;
  const tollPaid = !!routeTollProof;
  const canUseRecommendation = chatResult && !chatResult.needs_clarification && (!tollNeeded || tollPaid);

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div>
        <h1 className="page-title">AI Tutor</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          Chat, pay route toll, propose path, unlock lessons.
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

        {routeTollError && (
          <div style={{ padding: "10px 12px", background: "var(--danger-soft)", borderRadius: 8, fontSize: 13, color: "var(--danger)", marginBottom: 12 }}>
            {routeTollError}
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
                Goal: {chatResult.normalized_goal} · Budget: {chatResult.suggested_budget_usdc} USDC · Level: {chatResult.learning_level} · Confidence: {Math.round(chatResult.confidence * 100)}%
              </div>
            )}

            {chatResult.needs_clarification && chatResult.clarification_question && (
              <div style={{ fontSize: 13, color: "var(--warning)", fontWeight: 500, marginBottom: 8 }}>
                {chatResult.clarification_question}
              </div>
            )}

            {/* Toll needed */}
            {!chatResult.needs_clarification && tollNeeded && !tollPaid && (
              <div style={{ padding: 12, background: "var(--warning-soft)", borderRadius: 8, fontSize: 13, marginBottom: 8, border: "1px solid var(--warning)30" }}>
                <div style={{ marginBottom: 8 }}>
                  Route toll: <strong className="data-mono">{chatResult.route_toll_amount_usdc} USDC</strong> for {chatResult.route_label}
                </div>
                <button onClick={payRouteToll} disabled={routeTollPaying || !wallet} className="btn btn-primary" style={{ fontSize: 13 }}>
                  {routeTollPaying ? "Paying…" : `Pay ${chatResult.route_toll_amount_usdc} USDC`}
                </button>
                {!wallet && <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>Connect wallet first</span>}
              </div>
            )}

            {/* Toll paid */}
            {!chatResult.needs_clarification && tollPaid && routeTollProof && (
              <div style={{ padding: "8px 12px", background: "var(--success-soft)", borderRadius: 8, fontSize: 12, marginBottom: 8, border: "1px solid var(--success)20" }}>
                <span style={{ color: "var(--success)", fontWeight: 600 }}>✓ Toll paid</span>{" "}
                {routeTollProof.route_label} · <strong className="data-mono">{routeTollProof.route_toll_amount_usdc} USDC</strong>
                {routeTollProof.route_payment_id && (
                  <span className="muted"> · {short(routeTollProof.route_payment_id)}</span>
                )}
              </div>
            )}

            {/* Use recommendation */}
            {!chatResult.needs_clarification && canUseRecommendation && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button onClick={useRecommendation} className="btn btn-green" style={{ fontSize: 13 }}>
                  Use Recommendation
                </button>
                <span className="muted" style={{ fontSize: 12 }}>
                  {tollPaid ? "Toll paid. Click Propose Path next." : "No funds spent yet."}
                </span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Step 2: Pay route toll (manual route selector) */}
      <section className="card-soft">
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>Manual route override</div>
        <div className="grid-3">
          {ROUTE_OPTIONS.map((route) => (
            <button
              key={route.tier}
              onClick={() => {
                setSelectedRoute(route.tier);
                if (routeTollProof && route.tier !== routeTollProof.route_tier) setRouteTollProof(null);
              }}
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

      {/* Step 3: Propose path */}
      <section className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <span style={{
            width: 24, height: 24, borderRadius: "50%", background: "var(--foreground)",
            color: "white", display: "inline-flex", alignItems: "center", justifyContent: "center",
            fontSize: 12, fontWeight: 700, flexShrink: 0,
          }}>3</span>
          <span style={{ fontWeight: 700, fontSize: 15 }}>Propose path</span>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <div>
            <label className="muted" style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Learning Goal</label>
            <input className="input" value={goal} onChange={(e) => { setGoal(e.target.value); if (routeTollProof) setRouteTollProof(null); }} placeholder="e.g. Learn x402 nanopayments on Arc" />
          </div>
          <div>
            <label className="muted" style={{ display: "block", fontSize: 12, marginBottom: 4 }}>Budget (USDC)</label>
            <input className="input" type="number" step="0.001" value={budget} onChange={(e) => setBudget(e.target.value)} style={{ maxWidth: 160 }} />
          </div>
          <button onClick={proposePath} disabled={loading || !goal || !wallet} className="btn btn-primary">
            {loading ? "Running workflow…" : `Propose ${ROUTE_OPTIONS.find(r => r.tier === selectedRoute)?.label || "Path"}`}
          </button>
        </div>
      </section>

      {/* Agent Economy Trace */}
      {agentServiceCalls.length > 0 && (
        <section className="card" style={{ border: "1px solid var(--success)30" }}>
          <h2 className="section-title" style={{ color: "var(--success)" }}>Agent Economy Trace</h2>
          <div style={{ display: "grid", gap: 8 }}>
            {agentServiceCalls.map((call, i) => (
              <div key={call.id || i} className="card-soft" style={{ padding: "10px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 13 }}>
                    <strong className="data-mono">{short(call.buyer_agent_id)}</strong>
                    {" → "}
                    <strong className="data-mono">{short(call.provider_agent_id)}</strong>
                  </span>
                  <span style={{ color: "var(--success)", fontWeight: 700, fontSize: 13 }} className="data-mono">
                    {call.amount_usdc} USDC
                  </span>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {call.service_type} ·{" "}
                  <span className={`badge ${call.status === "completed" ? "badge-success" : "badge-warning"}`} style={{ fontSize: 11 }}>
                    {call.status}
                  </span>
                  {call.payment_id && <> · <span className="data-mono">{short(call.payment_id)}</span></>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Proposed Path */}
      {path && (
        <section className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <h2 className="section-title" style={{ margin: 0 }}>
              Proposed Path
              {pathId && <span className="muted data-mono" style={{ fontSize: 12, marginLeft: 8 }}>{short(pathId)}</span>}
            </h2>
            <span className="data-mono" style={{ fontWeight: 700, fontSize: 15 }}>{total.toFixed(4)} USDC</span>
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
            {path.map((l: ProposedLesson, i: number) => (
              <div
                key={l.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "12px 14px",
                  background: unlockedIds.has(l.id) ? "var(--success-soft)" : "var(--card-soft)",
                  borderRadius: 10,
                  border: `1px solid ${unlockedIds.has(l.id) ? "var(--success)30" : "var(--border)"}`,
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {i + 1}. {l.title}
                    {unlockedIds.has(l.id) && <span style={{ color: "var(--success)", marginLeft: 8, fontSize: 12 }}>✓ Unlocked</span>}
                  </div>
                  {l.verification_reason && (
                    <div style={{ fontSize: 12, color: "var(--success)", marginTop: 2 }}>✓ {l.verification_reason}</div>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className="data-mono" style={{ fontWeight: 700, color: "var(--success)" }}>{l.price_usdc} USDC</span>
                  {!unlockedIds.has(l.id) && (
                    <button
                      onClick={() => buyLesson(l.id)}
                      disabled={!isApproved || buyingLessonId === l.id}
                      className="btn btn-green"
                      style={{ fontSize: 13, opacity: isApproved ? 1 : 0.4 }}
                    >
                      {buyingLessonId === l.id ? "Buying…" : isApproved ? "Buy" : "Approve first"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {buyStatus && (
            <p style={{ marginTop: 12, fontSize: 13, color: buyStatus.startsWith("Error") ? "var(--danger)" : "var(--success)" }}>
              {buyStatus}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
