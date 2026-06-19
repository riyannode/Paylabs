"use client";
import { useState, useEffect } from "react";

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
  detail: string;
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
  tx_hash?: string;
  output_hash?: string;
  status?: string;
}

const ROUTE_OPTIONS: RouteOption[] = [
  {
    tier: "normal",
    label: "Normal Route",
    maxLessons: 2,
    description: "Quick intro",
    detail: "Up to 2 lessons. Cheapest useful path.",
  },
  {
    tier: "advanced",
    label: "Advanced Route",
    maxLessons: 5,
    description: "Builder path",
    detail: "Up to 5 lessons. Technical sequencing.",
  },
  {
    tier: "premium",
    label: "Premium Route",
    maxLessons: 8,
    description: "Deep mastery",
    detail: "Up to 8 lessons. Strictest source verification.",
  },
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
  // Tutor Intake Agent chat state
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
    // Route toll fields
    route_toll_enabled?: boolean;
    route_toll_required?: boolean;
    route_toll_amount_usdc?: number;
    route_payment_id?: string;
    route_payment_ref?: string;
    route_settlement_ref?: string;
    route_payment_status?: string;
    route_payment_error?: string;
    route_input_hash?: string;
  } | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [path, setPath] = useState<ProposedLesson[] | null>(null);
  const [pathId, setPathId] = useState<string | null>(null);
  const [pathStatus, setPathStatus] = useState<string>("none");
  const [routeTier, setRouteTier] = useState<string>("normal");
  const [routeDescription, setRouteDescription] = useState<string>("");
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
        if (data.needs_clarification) {
          setChatError(null);
        }
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
    if (chatResult.needs_clarification) return; // Don't auto-fill if clarification needed
    // If route toll is enabled and required, payment must be completed
    if (
      chatResult.route_toll_enabled &&
      chatResult.route_toll_required &&
      chatResult.route_payment_status !== "completed"
    )
      return;
    if (chatResult.normalized_goal) setGoal(chatResult.normalized_goal);
    if (chatResult.recommended_route_tier)
      setSelectedRoute(chatResult.recommended_route_tier);
    if (chatResult.suggested_budget_usdc)
      setBudget(chatResult.suggested_budget_usdc.toString());
  }

  async function proposePath() {
    if (!wallet) {
      setBuyStatus("Connect wallet first");
      return;
    }
    setLoading(true);
    setPath(null);
    setPathId(null);
    setPathStatus("none");
    setBuyStatus("");
    setUnlockedIds(new Set());
    setAgentServiceCalls([]);
    try {
      const res = await fetch("/api/paylabs/learning-paths/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal,
          budget_usdc: parseFloat(budget),
          user_wallet: wallet,
          route_tier: selectedRoute,
        }),
      });
      const data = await res.json();
      if (data.path) {
        setPath(data.path);
        setPathId(data.path_id || null);
        setPathStatus(data.path_status || "none");
        setRouteTier(data.route_tier || selectedRoute);
        setRouteDescription(data.route_config?.description || "");
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
        setBuyStatus("Path approved! You can now buy lessons.");
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
    if (!wallet) {
      setBuyStatus("Connect wallet first");
      return;
    }
    if (!pathId) {
      setBuyStatus("Error: No path_id. Propose and approve a path first.");
      return;
    }
    if (pathStatus !== "approved") {
      setBuyStatus("Error: Path must be approved before buying.");
      return;
    }
    setBuyingLessonId(lessonId);
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
        setBuyStatus(
          `Unlocked! Payment: ${data.payment_id || "pending settlement"}`
        );
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

  const isApproved = pathStatus === "approved";
  const isProposed = pathStatus === "proposed";

  return (
    <div>
      <h1 style={{ fontSize: "2rem", fontWeight: 700, marginBottom: "0.5rem" }}>
        AI Tutor
      </h1>
      <p style={{ color: "var(--muted)", marginBottom: "2rem" }}>
        5-agent LangGraph workflow: Intent → Curriculum Planner → Source Verifier
        → Policy Guard → Payment Executor. All payments through ArcLayer Runner.
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

      {/* Tutor Intake Agent chat panel */}
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <label
          style={{
            display: "block",
            fontSize: "0.875rem",
            color: "var(--muted)",
            marginBottom: "0.75rem",
          }}
        >
          💬 Describe what you want to learn — the Tutor Agent will recommend a
          route
        </label>
        <div style={{ display: "flex", gap: "0.75rem", marginBottom: "0.75rem" }}>
          <input
            className="input"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder='e.g. "I want to build an x402 paying agent on Arc"'
            onKeyDown={(e) => {
              if (e.key === "Enter" && !chatLoading) askTutorAgent();
            }}
            style={{ flex: 1 }}
          />
          <button
            onClick={askTutorAgent}
            disabled={chatLoading || !chatInput.trim()}
            className="btn btn-primary"
            style={{ whiteSpace: "nowrap" }}
          >
            {chatLoading ? "Thinking..." : "Ask Tutor Agent"}
          </button>
        </div>

        {/* Chat error */}
        {chatError && (
          <div
            style={{
              padding: "0.75rem",
              background: "rgba(239,68,68,0.08)",
              borderRadius: 8,
              fontSize: "0.85rem",
              color: "#ef4444",
              marginBottom: "0.75rem",
            }}
          >
            {chatError}
          </div>
        )}

        {/* Chat result */}
        {chatResult && (
          <div
            style={{
              padding: "1rem",
              background: chatResult.needs_clarification
                ? "rgba(245,158,11,0.08)"
                : "rgba(34,197,94,0.08)",
              borderRadius: 8,
              border: chatResult.needs_clarification
                ? "1px solid rgba(245,158,11,0.3)"
                : "1px solid rgba(34,197,94,0.3)",
            }}
          >
            {/* Route recommendation badge */}
            {!chatResult.needs_clarification && (
              <div
                style={{
                  display: "inline-block",
                  padding: "0.25rem 0.6rem",
                  background: "rgba(34,197,94,0.15)",
                  borderRadius: 6,
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  color: "var(--accent-green)",
                  marginBottom: "0.5rem",
                }}
              >
                Tutor Intake Agent recommends: {chatResult.route_label}
              </div>
            )}

            {/* Assistant message */}
            <div
              style={{
                fontSize: "0.9rem",
                lineHeight: 1.5,
                marginBottom: "0.5rem",
              }}
            >
              {chatResult.assistant_message}
            </div>

            {/* Reasoning */}
            {chatResult.reasoning && (
              <div
                style={{
                  fontSize: "0.8rem",
                  color: "var(--muted)",
                  marginBottom: "0.5rem",
                  fontStyle: "italic",
                }}
              >
                Reason: {chatResult.reasoning}
              </div>
            )}

            {/* Clarification question */}
            {chatResult.needs_clarification &&
              chatResult.clarification_question && (
                <div
                  style={{
                    fontSize: "0.85rem",
                    color: "#f59e0b",
                    marginBottom: "0.5rem",
                    fontWeight: 500,
                  }}
                >
                  ❓ {chatResult.clarification_question}
                </div>
              )}

            {/* Suggested details (when not clarification) */}
            {!chatResult.needs_clarification && (
              <div
                style={{
                  fontSize: "0.8rem",
                  color: "var(--muted)",
                  marginBottom: "0.75rem",
                }}
              >
                Goal: {chatResult.normalized_goal} • Budget:{" "}
                {chatResult.suggested_budget_usdc} USDC • Level:{" "}
                {chatResult.learning_level} • Confidence:{" "}
                {Math.round(chatResult.confidence * 100)}%
              </div>
            )}

            {/* Route toll proof display */}
            {!chatResult.needs_clarification &&
              chatResult.route_toll_enabled &&
              chatResult.route_toll_required && (
                <div
                  style={{
                    padding: "0.6rem 0.75rem",
                    background:
                      chatResult.route_payment_status === "completed"
                        ? "rgba(34,197,94,0.1)"
                        : "rgba(239,68,68,0.08)",
                    borderRadius: 6,
                    fontSize: "0.8rem",
                    marginBottom: "0.75rem",
                    border:
                      chatResult.route_payment_status === "completed"
                        ? "1px solid rgba(34,197,94,0.3)"
                        : "1px solid rgba(239,68,68,0.3)",
                  }}
                >
                  {chatResult.route_payment_status === "completed" ? (
                    <>
                      ✅ Route Guard paid {chatResult.route_label} Agent{" "}
                      <strong>{chatResult.route_toll_amount_usdc} USDC</strong>{" "}
                      via x402 before running the path workflow.
                      {chatResult.route_payment_id && (
                        <span style={{ color: "var(--muted)" }}>
                          {" "}
                          • Payment: {chatResult.route_payment_id.slice(0, 12)}
                          ...
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      ❌ Route toll payment failed:{" "}
                      {chatResult.route_payment_error || "Unknown error"}
                    </>
                  )}
                </div>
              )}

            {/* Use recommendation button — only when not clarification */}
            {!chatResult.needs_clarification && (
              <div>
                <button
                  onClick={useRecommendation}
                  className="btn btn-green"
                  style={{
                    fontSize: "0.85rem",
                    marginRight: "0.75rem",
                    opacity:
                      chatResult.route_toll_enabled &&
                      chatResult.route_toll_required &&
                      chatResult.route_payment_status !== "completed"
                        ? 0.4
                        : 1,
                  }}
                  disabled={
                    !!(
                      chatResult.route_toll_enabled &&
                      chatResult.route_toll_required &&
                      chatResult.route_payment_status !== "completed"
                    )
                  }
                >
                  Use Recommendation
                </button>
                <span
                  style={{ fontSize: "0.75rem", color: "var(--muted)" }}
                >
                  This does not spend funds yet. Use recommendation, then click
                  Propose Path.
                </span>
              </div>
            )}

            {/* When clarification needed, let user know they can reply */}
            {chatResult.needs_clarification && (
              <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                Reply in the chat above to clarify, then ask again.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Route selector cards */}
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <label
          style={{
            display: "block",
            fontSize: "0.875rem",
            color: "var(--muted)",
            marginBottom: "0.75rem",
          }}
        >
          Select Route
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.75rem" }}>
          {ROUTE_OPTIONS.map((route) => (
            <button
              key={route.tier}
              onClick={() => {
                setSelectedRoute(route.tier);
                // Clear route toll proof if user manually changes route after toll was paid
                if (
                  chatResult?.route_toll_enabled &&
                  chatResult?.route_payment_status === "completed" &&
                  route.tier !== chatResult?.recommended_route_tier
                ) {
                  setChatResult(null);
                }
              }}
              style={{
                padding: "1rem",
                borderRadius: 8,
                border: selectedRoute === route.tier
                  ? "2px solid var(--accent-green)"
                  : "2px solid rgba(255,255,255,0.1)",
                background: selectedRoute === route.tier
                  ? "rgba(34,197,94,0.08)"
                  : "rgba(255,255,255,0.03)",
                cursor: "pointer",
                textAlign: "left",
                transition: "all 0.15s",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.25rem" }}>
                {route.label}
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginBottom: "0.5rem" }}>
                {route.description}
              </div>
              <div style={{ fontSize: "0.7rem", color: "var(--muted)" }}>
                {route.detail}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Goal + budget input */}
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <div style={{ display: "grid", gap: "1rem" }}>
          <div>
            <label
              style={{
                display: "block",
                fontSize: "0.875rem",
                color: "var(--muted)",
                marginBottom: "0.25rem",
              }}
            >
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
            <label
              style={{
                display: "block",
                fontSize: "0.875rem",
                color: "var(--muted)",
                marginBottom: "0.25rem",
              }}
            >
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
          <button
            onClick={proposePath}
            disabled={loading || !goal || !wallet}
            className="btn btn-primary"
          >
            {loading ? "Running 5-agent workflow..." : `Propose ${ROUTE_OPTIONS.find(r => r.tier === selectedRoute)?.label || "Learning Path"}`}
          </button>
        </div>
      </div>

      {/* Agent Economy Trace panel */}
      {agentServiceCalls.length > 0 && (
        <div
          className="card"
          style={{
            marginBottom: "1.5rem",
            border: "1px solid rgba(34,197,94,0.3)",
          }}
        >
          <h2
            style={{
              fontSize: "1.1rem",
              fontWeight: 600,
              marginBottom: "0.75rem",
              color: "var(--accent-green)",
            }}
          >
            ⚡ Agent Economy Trace
          </h2>
          <p
            style={{
              fontSize: "0.8rem",
              color: "var(--muted)",
              marginBottom: "0.75rem",
            }}
          >
            Agent-to-agent payments executed via x402/ArcLayer Runner (RFB 03)
          </p>
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {agentServiceCalls.map((call, i) => (
              <div
                key={call.id || i}
                style={{
                  padding: "0.6rem 0.75rem",
                  background: "rgba(255,255,255,0.03)",
                  borderRadius: 6,
                  fontSize: "0.8rem",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.25rem" }}>
                  <span>
                    <strong>{call.buyer_agent_id?.slice(0, 20) || "orchestrator"}</strong>
                    {" → "}
                    <strong>{call.provider_agent_id?.slice(0, 25) || "specialist"}</strong>
                  </span>
                  <span style={{ color: "var(--accent-green)", fontWeight: 700 }}>
                    {call.amount_usdc} USDC
                  </span>
                </div>
                <div style={{ color: "var(--muted)", fontSize: "0.75rem" }}>
                  {call.service_type} •{" "}
                  <span style={{ color: call.status === "completed" ? "var(--accent-green)" : "#f59e0b" }}>
                    {call.status}
                  </span>
                  {call.payment_id && (
                    <> • Payment: {call.payment_id.slice(0, 12)}...</>
                  )}
                  {call.output_hash && (
                    <> • Output: {call.output_hash.slice(0, 12)}...</>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Proposed path */}
      {path && (
        <div className="card">
          <h2
            style={{
              fontSize: "1.25rem",
              fontWeight: 600,
              marginBottom: "0.5rem",
            }}
          >
            Proposed Path (Total: {total.toFixed(4)} USDC)
            {pathId && (
              <span
                style={{
                  fontSize: "0.75rem",
                  color: "var(--muted)",
                  marginLeft: "0.5rem",
                }}
              >
                ID: {pathId.slice(0, 8)}...
              </span>
            )}
          </h2>

          {/* Route tier badge */}
          <div
            style={{
              fontSize: "0.8rem",
              color: "var(--accent-green)",
              marginBottom: "0.5rem",
              padding: "0.35rem 0.6rem",
              background: "rgba(34,197,94,0.08)",
              borderRadius: 6,
              display: "inline-block",
            }}
          >
            Route: <strong>{routeTier}</strong>
            {routeDescription && ` — ${routeDescription}`}
          </div>

          <div
            style={{
              fontSize: "0.8rem",
              color: isApproved
                ? "var(--accent-green)"
                : isProposed
                ? "#f59e0b"
                : "var(--muted)",
              marginBottom: "1rem",
              padding: "0.5rem 0.75rem",
              background: "rgba(255,255,255,0.03)",
              borderRadius: 6,
            }}
          >
            Status: <strong>{pathStatus}</strong>
            {isProposed && " — Approve budget to enable purchases"}
            {isApproved && " — Ready to buy"}
          </div>

          {/* Approve button — only shown when proposed */}
          {isProposed && (
            <button
              onClick={approvePath}
              disabled={approving}
              className="btn btn-primary"
              style={{ marginBottom: "1rem" }}
            >
              {approving ? "Approving..." : "Approve Budget"}
            </button>
          )}

          <div style={{ display: "grid", gap: "0.75rem" }}>
            {path.map((l: ProposedLesson, i: number) => (
              <div
                key={l.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "0.75rem",
                  background: unlockedIds.has(l.id)
                    ? "rgba(34,197,94,0.1)"
                    : "rgba(255,255,255,0.03)",
                  borderRadius: 8,
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {i + 1}. {l.title}
                    {unlockedIds.has(l.id) && (
                      <span
                        style={{
                          color: "var(--accent-green)",
                          marginLeft: "0.5rem",
                          fontSize: "0.75rem",
                        }}
                      >
                        ✓ Unlocked
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: "0.8rem",
                      color: "var(--muted)",
                      marginTop: "0.25rem",
                    }}
                  >
                    {l.reason}
                  </div>
                  {l.verification_reason && (
                    <div
                      style={{
                        fontSize: "0.75rem",
                        color: "var(--accent-green)",
                        marginTop: "0.15rem",
                      }}
                    >
                      ✓ {l.verification_reason}
                    </div>
                  )}
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "1rem",
                  }}
                >
                  <span
                    style={{ fontWeight: 700, color: "var(--accent-green)" }}
                  >
                    {l.price_usdc} USDC
                  </span>
                  {!unlockedIds.has(l.id) && (
                    <button
                      onClick={() => buyLesson(l.id)}
                      disabled={!isApproved || buyingLessonId === l.id}
                      className="btn btn-green"
                      style={{
                        fontSize: "0.8rem",
                        opacity: isApproved ? 1 : 0.4,
                      }}
                    >
                      {buyingLessonId === l.id
                        ? "Buying..."
                        : isApproved
                        ? "Buy via Runner"
                        : "Approve first"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          {buyStatus && (
            <p
              style={{
                marginTop: "1rem",
                fontSize: "0.875rem",
                color: buyStatus.startsWith("Error")
                  ? "#ef4444"
                  : "var(--accent-green)",
              }}
            >
              {buyStatus}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
