"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import SidebarPanel from "@/components/paylabs/SidebarPanel";
import type { UcwBalance } from "@/components/paylabs/WalletConnectModal";
import DcwModal from "@/components/paylabs/DcwModal";
import PaymentExplorerLinks from "@/components/paylabs/PaymentExplorerLinks";
import { safeExplorerUrl as validateExplorerUrl } from "@/lib/paylabs/x402/payment-links";

// ─── Types ──────────────────────────────────────────────────

type Analytics = {
  uniqueUsers: number;
  active24h: number;
  active7d: number;
};

type Props = {
  analytics: Analytics;
};

type SourceLink = {
  title: string;
  url: string;
  domain: string | null;
  summary: string;
  rank: number;
  relevance_score: number;
};

type SafeRunResult = {
  ok: boolean;
  runId: string | null;
  status: string | null;
  requestedTier: string | null;
  tier: string | null;
  effectiveTier: string | null;
  entryPaymentStatus: string | null;
  plannedCostUsdc: number | null;
  paidEdges: number;
  totalEdges: number;
  receiptReady: boolean;
  safeSummary: string;
  assistantResponse: string | null;
  userVisibleReasoning: string | null;
  brainRationale: string | null;
  lockedNodes: string[];
  lockedServices: string[];
  tierDecisionReason: string | null;
  sourcesUsed: SourceLink[];
  // Payment link fields — chat renders direct explorer link only, never settlement UUID
  entryExplorerUrl: string | null;
  entrySettlementId: string | null;
  entryTransferStatus: string | null;
  entryGatewayAccepted: boolean;
  entryBatchExplorerUrl: string | null;
  entryBatchTxHash: string | null;
};

type ChatMessage =
  | { id: string; role: "user"; content: string; createdAt: number; }
  | { id: string; role: "assistant"; status: "running" | "done" | "error"; result?: SafeRunResult | null; error?: string | null; createdAt: number; };

function makeChatId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function formatChatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ─── Helpers ────────────────────────────────────────────────

function short(value?: string | null, chars = 6): string {
  if (!value) return "—";
  if (value.length <= chars * 2 + 3) return value;
  return `${value.slice(0, chars)}…${value.slice(-chars)}`;
}

/** Detect deterministic source inventory answers that should be hidden from user.
 *  NOTE: "Latest activity found for ..." is a real source-grounded answer from
 *  buildSourceGroundedFinalAnswer() — do NOT suppress it. */
function isSourceInventoryAnswer(value?: string | null): boolean {
  if (!value) return false;
  return (
    /Found\s+\d+\s+(relevant\s+)?sources/i.test(value) ||
    /Here are\s+\d+\s+latest sources/i.test(value) ||
    /No (sufficiently )?relevant sources found/i.test(value) ||
    /No relevant sources found for/i.test(value) ||
    /\(Mode:\s*(db_fallback|rsshub_live|tavily_live|none)\)/i.test(value)
  );
}

// Planned cost comes from backend /api/paylabs/quote. No frontend constants.

// ─── Safe Result Transformer ────────────────────────────────

function toSafeRunResult(data: Record<string, unknown>): SafeRunResult {
  const sourcesRaw = (data.sources_used ?? data.discovered_sources ?? []) as Array<Record<string, unknown>>;
  const sourcesUsed: SourceLink[] = sourcesRaw.map((s) => ({
    title: (s.title as string) ?? "",
    url: (s.source_url as string) ?? (s.url as string) ?? "",
    domain: (s.domain as string) ?? null,
    summary: (s.summary as string) ?? "",
    rank: (s.rank as number) ?? 0,
    relevance_score: (s.relevance_score as number) ?? 0,
  }));

  const paymentMetadata = data.paymentMetadata as Record<string, unknown> | undefined;
  const entryPayment = data.entry_payment as Record<string, unknown> | undefined;

  // Resolve explorer URL from nested payment objects (handle both entry_payment and paymentMetadata shapes)
  const resolvedEntry =
    entryPayment ?? paymentMetadata ?? null;

  return {
    ok: (data.ok as boolean) ?? false,
    runId: (data.discovery_run_id as string) ?? (data.run_id as string) ?? (data.runId as string) ?? null,
    status: (data.status as string) ?? null,
    requestedTier: (data.requested_tier as string) ?? (data.requestedTier as string) ?? null,
    tier: (data.route_tier as string) ?? (data.tier as string) ?? null,
    effectiveTier: (data.effective_tier as string) ?? (data.effectiveTier as string) ?? null,
    entryPaymentStatus: (data.entry_payment_status as string) ?? (data.entryPaymentStatus as string) ?? (paymentMetadata?.status as string) ?? null,
    plannedCostUsdc: (data.planned_cost_usdc as number) ?? (data.plannedCostUsdc as number) ?? null,
    paidEdges: (data.paid_edges as number) ?? 0,
    totalEdges: (data.total_edges as number) ?? 0,
    receiptReady: (data.receipt_ready as boolean) ?? false,
    safeSummary: (data.safe_summary as string) ?? (data.safeSummary as string) ?? "",
    assistantResponse: (data.assistant_response as string) ?? (data.assistantResponse as string) ?? null,
    userVisibleReasoning: (data.user_visible_reasoning as string) ?? (data.userVisibleReasoning as string) ?? null,
    brainRationale: (data.brain_rationale as string) ?? (data.brainRationale as string) ?? null,
    lockedNodes: (data.locked_nodes as string[]) ?? (data.lockedNodes as string[]) ?? [],
    lockedServices: (data.locked_services as string[]) ?? (data.lockedServices as string[]) ?? [],
    tierDecisionReason: (data.tier_decision_reason as string) ?? (data.tierDecisionReason as string) ?? null,
    sourcesUsed,
    entryExplorerUrl:
      (data.entry_explorer_url as string) ??
      (data.entryExplorerUrl as string) ??
      (resolvedEntry?.explorer_url as string | null | undefined) ??
      (paymentMetadata?.explorerUrl as string | null | undefined) ??
      null,
    entrySettlementId:
      (data.entry_settlement_id as string) ??
      (data.entrySettlementId as string) ??
      (resolvedEntry?.settlement_id as string | null | undefined) ??
      (paymentMetadata?.settlementId as string | null | undefined) ??
      null,
    entryTransferStatus:
      (data.entry_transfer_status as string) ??
      (data.entryTransferStatus as string) ??
      (resolvedEntry?.transfer_status as string | null | undefined) ??
      (paymentMetadata?.transferStatus as string | null | undefined) ??
      null,
    entryGatewayAccepted:
      (data.entry_gateway_accepted as boolean) ??
      (data.entryGatewayAccepted as boolean) ??
      (resolvedEntry?.gateway_accepted as boolean | null | undefined) ??
      (paymentMetadata?.gatewayAccepted as boolean | null | undefined) ??
      false,
    entryBatchExplorerUrl:
      (data.entry_batch_explorer_url as string) ??
      (data.entryBatchExplorerUrl as string) ??
      (resolvedEntry?.batch_explorer_url as string | null | undefined) ??
      (paymentMetadata?.batchExplorerUrl as string | null | undefined) ??
      null,
    entryBatchTxHash:
      (data.entry_batch_tx_hash as string) ??
      (data.entryBatchTxHash as string) ??
      (resolvedEntry?.batch_tx_hash as string | null | undefined) ??
      (paymentMetadata?.batchTxHash as string | null | undefined) ??
      null,
  };
}

// ─── DCW Balance Fetcher ────────────────────────────────────

/** Fetch DCW balance — on-chain wallet USDC + Gateway x402 balance */
async function fetchDcwBalance(): Promise<UcwBalance> {
  const resp = await fetch("/api/paylabs/dcw/balance", { credentials: "include" });
  if (!resp.ok) return { walletUsdc: "0", gatewayUsdc: "0", source: "dcw" };
  const data = await resp.json();
  if (!data.ok) return { walletUsdc: "0", gatewayUsdc: "0", source: "dcw" };
  return {
    walletUsdc: data.wallet?.usdc ?? "0",
    // null means gateway check failed — preserve as null so UI can show error
    gatewayUsdc: data.gateway?.balanceUsdc ?? (data.gateway?.ok === false ? null : "0"),
    pendingBatchUsdc: data.gateway?.pendingBatchUsdc,
    gatewayError: data.gateway?.error ?? null,
    source: "dcw",
  };
}

// ─── Wallet Info Type ───────────────────────────────────────

type WalletInfo = {
  address: string;
  walletType: "circle_developer_controlled";
  network: string;
};

// ─── Main Component ─────────────────────────────────────────

export default function PayLabsChatClient({ analytics }: Props) {
  // Chat state
  const [prompt, setPrompt] = useState("");

  const [budget, setBudget] = useState("0.0001");
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SafeRunResult | null>(null);
  const [signingPhase, setSigningPhase] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  // Chat message history
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const chatThreadRef = useRef<HTMLDivElement | null>(null);

  // Wallet state — DCW only
  const [dcwOpen, setDcwOpen] = useState(false);
  const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null);
  const [ucwBalance, setUcwBalance] = useState<UcwBalance | null>(null);
  const [walletCopied, setWalletCopied] = useState(false);

  // DCW wallet signing state
  const [walletState, setWalletState] = useState<"not_connected" | "connected" | "needs_gateway_deposit" | "ready_to_approve" | "approving" | "paid" | "failed">("not_connected");

  // Backend-driven planned cost (replaces hardcoded TIER_COSTS)
  const [plannedCostUsdc, setPlannedCostUsdc] = useState<number>(0.000015); // conservative default (advanced tier)
  const [quoteRouteTier, setQuoteRouteTier] = useState<string>("advanced");

  const planned = useMemo(() => plannedCostUsdc.toFixed(6), [plannedCostUsdc]);

  // Batch link polling
  const batchPollRef = useRef<{ attempts: number; timer: ReturnType<typeof setTimeout> | null }>({ attempts: 0, timer: null });
  // DCW async job polling
  const dcwJobRef = useRef<{ jobId: string | null; timer: ReturnType<typeof setTimeout> | null; cancelled: boolean }>({ jobId: null, timer: null, cancelled: false });

  // Fetch quote from backend when budget or tier changes
  useEffect(() => {
    const tier = "auto";
    const budgetNum = parseFloat(budget) || 0.01;
    let cancelled = false;

    (async () => {
      try {
        const resp = await fetch("/api/paylabs/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ route_tier: tier, budget_usdc: budgetNum }),
        });
        if (!resp.ok || cancelled) return;
        const data = await resp.json();
        if (data.ok && typeof data.plannedCostUsdc === "number") {
          setPlannedCostUsdc(data.plannedCostUsdc);
          setQuoteRouteTier(data.quote_route_tier || "advanced");
        }
      } catch { /* quote fetch failed — use default */ }
    })();

    return () => { cancelled = true; };
  }, [budget]);

  // Auto-scroll chat thread
  useEffect(() => {
    chatThreadRef.current?.scrollTo({ top: chatThreadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // ── Batch link polling ──
  useEffect(() => {
    const r = result;
    if (!r?.entrySettlementId) return;
    if (r.entryBatchExplorerUrl || r.entryBatchTxHash) return;
    if (batchPollRef.current.timer) return;

    const MAX_ATTEMPTS = 30;
    const INTERVAL_MS = 10_000;

    const poll = async () => {
      if (batchPollRef.current.attempts >= MAX_ATTEMPTS) return;
      batchPollRef.current.attempts++;

      try {
        const resp = await fetch(
          `/api/paylabs/x402/batch-tx/${encodeURIComponent(r.entrySettlementId!)}`,
          { credentials: "include" },
        );
        if (!resp.ok) return;
        const data = await resp.json();
        if (data?.batchTxHash && data?.batchExplorerUrl) {
          setResult((prev) => prev ? {
            ...prev,
            entryBatchTxHash: data.batchTxHash,
            entryBatchExplorerUrl: data.batchExplorerUrl,
          } : prev);
          return;
        }
      } catch {
        // retry on next tick
      }

      batchPollRef.current.timer = setTimeout(poll, INTERVAL_MS);
    };

    batchPollRef.current.timer = setTimeout(poll, INTERVAL_MS);

    return () => {
      if (batchPollRef.current.timer) {
        clearTimeout(batchPollRef.current.timer);
        batchPollRef.current.timer = null;
      }
    };
  }, [result?.entrySettlementId, result?.entryBatchExplorerUrl, result?.entryBatchTxHash]);

  // ── DCW session restore on mount ──
  useEffect(() => {
    let cancelled = false;

    const restoreDcwSession = async () => {
      try {
        const dcwSessionResp = await fetch("/api/paylabs/auth/session", { credentials: "include" });
        if (cancelled) return;
        if (dcwSessionResp.ok) {
          const dcwSession = await dcwSessionResp.json();
          if (dcwSession.ok && dcwSession.authenticated && dcwSession.hasWallet && dcwSession.walletAddress) {
            setWalletInfo({
              address: dcwSession.walletAddress,
              walletType: "circle_developer_controlled",
              network: "ARC-TESTNET",
            });
            const dcwBal = await fetchDcwBalance();
            if (cancelled) return;
            setUcwBalance(dcwBal);
            const x402Bal = parseFloat(dcwBal.gatewayUsdc ?? "0");
            setWalletState(x402Bal > 0 ? "ready_to_approve" : "needs_gateway_deposit");
          }
        }
      } catch { /* no DCW session — normal first-visit state */ }
    };
    restoreDcwSession();

    return () => { cancelled = true; };
  }, []);

  // ── Submit chat (DCW only) ──
  const submitChat = useCallback(async () => {
    if (!prompt.trim()) return;

    // Run gating: must have DCW wallet
    if (!walletInfo?.address) {
      setDcwOpen(true);
      return;
    }

    // Run gating: must have sufficient x402 Balance (Gateway) for planned cost
    if (ucwBalance) {
      const x402Bal = parseFloat(ucwBalance.gatewayUsdc ?? "0");
      const costNum = parseFloat(planned);
      if (x402Bal < costNum) {
        setDcwOpen(true);
        return;
      }
    }

    const userMsg: ChatMessage = { id: makeChatId("user"), role: "user", content: prompt.trim(), createdAt: Date.now() };
    const assistantId = makeChatId("assistant");
    const assistantMsg: ChatMessage = { id: assistantId, role: "assistant", status: "running", createdAt: Date.now() };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setPrompt("");
    setStatus("running");
    setError(null);
    setResult(null);

    const finishAssistant = (patch: Partial<Extract<ChatMessage, { role: "assistant" }>>) => {
      setMessages((prev) => prev.map((msg) =>
        msg.role === "assistant" && msg.id === assistantId
          ? { ...msg, ...patch }
          : msg,
      ));
    };

    try {
      // ── DCW: server-side run-paid ──
      setWalletState("approving");
      setSigningPhase("Starting DCW payment…");

      // ── Fire-and-forget: POST to get jobId ──
      dcwJobRef.current.cancelled = false;
      let jobId: string;
      try {
        const startResp = await fetch("/api/paylabs/dcw/run-paid", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            goal: prompt.trim(),
            routeTier: "auto",
            budgetUsdc: Number(budget),
          }),
        });
        const startData = await startResp.json();
        if (!startData.ok || !startData.jobId) {
          throw new Error(startData.error || "Failed to start DCW job");
        }
        jobId = startData.jobId;
        dcwJobRef.current.jobId = jobId;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Failed to start payment.";
        setSigningPhase(null);
        finishAssistant({ status: "error", error: msg });
        setError(msg);
        setWalletState("failed");
        setStatus("error");
        return;
      }

      // ── Poll for job completion ──
      const POLL_INTERVAL_MS = 3_000;
      const MAX_POLL_ATTEMPTS = 120;
      let pollAttempts = 0;

      const pollJob = (): Promise<void> =>
        new Promise((resolve) => {
          const tick = async () => {
            if (dcwJobRef.current.cancelled) {
              setSigningPhase(null);
              finishAssistant({ status: "error", error: "Request cancelled." });
              setWalletState("ready_to_approve");
              setStatus("idle");
              resolve();
              return;
            }

            pollAttempts++;
            if (pollAttempts > MAX_POLL_ATTEMPTS) {
              setSigningPhase(null);
              finishAssistant({ status: "error", error: "Payment timed out. The request may still complete — check your wallet." });
              setWalletState("failed");
              setStatus("error");
              resolve();
              return;
            }

            try {
              const pollResp = await fetch(
                `/api/paylabs/dcw/run-paid/status?jobId=${encodeURIComponent(jobId)}`,
                { credentials: "include" },
              );
              const pollData = await pollResp.json();

              if (!pollResp.ok || !pollData.ok) {
                if (pollAttempts > 5) {
                  setSigningPhase(null);
                  finishAssistant({ status: "error", error: pollData.error || "Lost track of payment job." });
                  setWalletState("failed");
                  setStatus("error");
                  resolve();
                  return;
                }
              } else {
                if (pollData.progress) {
                  setSigningPhase(pollData.progress);
                }

                if (pollData.status === "completed" && pollData.result) {
                  setSigningPhase(null);
                  const dcwResult = pollData.result;
                  const dcwData =
                    dcwResult.data && typeof dcwResult.data === "object"
                      ? (dcwResult.data as Record<string, unknown>)
                      : {};

                  const safeResult = toSafeRunResult({
                    ...dcwData,
                    entry_payment: dcwResult.entry_payment ?? dcwData.entry_payment,
                    paymentMetadata: dcwResult.paymentMetadata ?? dcwData.paymentMetadata,
                    entry_payment_explorer_url:
                      dcwResult.entry_payment?.explorer_url ??
                      dcwResult.paymentMetadata?.explorerUrl ??
                      dcwData.entry_payment_explorer_url ??
                      null,
                    entry_payment_batch_explorer_url:
                      dcwResult.entry_payment?.batch_explorer_url ??
                      dcwResult.paymentMetadata?.batchExplorerUrl ??
                      dcwData.entry_payment_batch_explorer_url ??
                      null,
                  });
                  setWalletState("paid");
                  finishAssistant({ status: "done", result: safeResult });
                  setResult(safeResult);
                  setStatus("done");
                  dcwJobRef.current.jobId = null;
                  resolve();
                  return;
                }

                if (pollData.status === "failed") {
                  setSigningPhase(null);
                  const errMsg = pollData.error || "DCW payment failed.";
                  finishAssistant({ status: "error", error: errMsg });
                  setError(errMsg);
                  setWalletState("failed");
                  setStatus("error");
                  dcwJobRef.current.jobId = null;
                  resolve();
                  return;
                }

                if (pollData.status === "cancelled") {
                  setSigningPhase(null);
                  finishAssistant({ status: "error", error: "Request cancelled." });
                  setWalletState("ready_to_approve");
                  setStatus("idle");
                  dcwJobRef.current.jobId = null;
                  resolve();
                  return;
                }
              }
            } catch {
              // Network error — retry on next tick
            }

            if (!dcwJobRef.current.cancelled) {
              dcwJobRef.current.timer = setTimeout(tick, POLL_INTERVAL_MS);
            }
          };

          if (!dcwJobRef.current.cancelled) {
            dcwJobRef.current.timer = setTimeout(tick, 100);
          }
        });

      await pollJob();

      if (dcwJobRef.current.timer) {
        clearTimeout(dcwJobRef.current.timer);
        dcwJobRef.current.timer = null;
      }
      return;
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : "Network error.";
      finishAssistant({ status: "error", error: errMsg });
      setError(errMsg);
      setStatus("error");
    }
  }, [prompt, budget, walletInfo, ucwBalance, planned]);

  const resetChat = useCallback(() => {
    setPrompt("");
    setResult(null);
    setError(null);
    setStatus("idle");
    setMessages([]);
  }, []);

  // ── Disconnect wallet ──
  const disconnectWallet = useCallback(() => {
    fetch("/api/paylabs/auth/session", { method: "DELETE", credentials: "include" }).catch(() => {});
    setWalletInfo(null);
    setWalletState("not_connected");
    setUcwBalance(null);
  }, []);

  const copyWalletAddress = useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!walletInfo?.address) return;
    try {
      await navigator.clipboard?.writeText(walletInfo.address);
      setWalletCopied(true);
      window.setTimeout(() => setWalletCopied(false), 1200);
    } catch {
      /* clipboard not available */
    }
  }, [walletInfo?.address]);

  return (
    <div className="pl-app">
      <SidebarPanel analytics={analytics} />

      <main className="pl-main">
        <div className="pl-topbar">
          <div />

          <button
            type="button"
            className={`pl-wallet-pill ${walletInfo?.address ? "connected" : ""}`}
            onClick={() => setDcwOpen(true)}
            title={walletInfo?.address || "Connect wallet"}
          >
            {walletInfo?.address ? (
              <>
                <span className="pl-wallet-dot" />
                <span className="pl-wallet-pill-address">{short(walletInfo.address)}</span>
                <span className="pl-wallet-pill-network">Arc</span>
                <span className="pl-wallet-pill-balance">
                  x402: {ucwBalance?.gatewayUsdc ?? "0.00"} USDC
                </span>
                {ucwBalance?.walletUsdc && ucwBalance.walletUsdc !== "0" && (
                  <span className="pl-wallet-pill-balance" style={{ fontSize: 10, opacity: 0.7, marginLeft: 6 }}>
                    wallet: {ucwBalance.walletUsdc}
                  </span>
                )}
                <button
                  type="button"
                  className="pl-wallet-copy-btn"
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      const dcwBal = await fetchDcwBalance();
                      setUcwBalance(dcwBal);
                    } catch { /* refresh failed */ }
                  }}
                  aria-label="Refresh balance"
                  title="Refresh DCW balance"
                >
                  ↻
                </button>
                <button
                  type="button"
                  className="pl-wallet-copy-btn"
                  onClick={copyWalletAddress}
                  aria-label="Copy wallet address"
                  title="Copy wallet address"
                >
                  {walletCopied ? "✓" : "⧉"}
                </button>
                <button
                  type="button"
                  className="pl-wallet-copy-btn"
                  onClick={(e) => { e.stopPropagation(); disconnectWallet(); }}
                  aria-label="Disconnect wallet"
                  title="Disconnect wallet"
                  style={{ marginLeft: 2, fontSize: 12 }}
                >
                  ✕
                </button>
              </>
            ) : (
              <>
                <span className="pl-wallet-dot idle" />
                <span>Connect wallet</span>
              </>
            )}
          </button>
        </div>

        <section className="pl-hero">
          <h1>Ask PayLabs</h1>
          <p>Source Discovery, receipts, and x402 payments.</p>

          <div className={`pl-chat-shell ${messages.length > 0 ? "has-thread" : ""}`}>
            {messages.length > 0 && (
              <div className="pl-chat-thread" ref={chatThreadRef}>
                <div className="pl-day-divider">Today</div>
                {messages.map((msg) =>
                  msg.role === "user" ? (
                    <div key={msg.id} className="pl-user-message-row">
                      <div className="pl-user-message">
                        {msg.content}
                        <span className="pl-message-time">{formatChatTime(msg.createdAt)}</span>
                      </div>
                    </div>
                  ) : (
                    <div key={msg.id} className="pl-assistant-message-row">
                      <div className="pl-assistant-avatar pl-assistant-avatar-brain"><BrainIcon /></div>
                      <div className="pl-assistant-message-wrap">
                        <div className="pl-assistant-meta">
                          <b>PayLabs</b>
                          <span>{formatChatTime(msg.createdAt)}</span>
                        </div>
                        <div className="pl-assistant-card">
                          {msg.status === "running" && (
                            <div className="pl-typing-row">
                              <div className="pl-typing-dot" />
                              <div className="pl-typing-dot" />
                              <div className="pl-typing-dot" />
                              {signingPhase && <span className="pl-signing-phase">{signingPhase}</span>}
                              {signingPhase && dcwJobRef.current.jobId && (
                                <button
                                  type="button"
                                  className="pl-cancel-btn"
                                  onClick={() => {
                                    dcwJobRef.current.cancelled = true;
                                    if (dcwJobRef.current.timer) {
                                      clearTimeout(dcwJobRef.current.timer);
                                      dcwJobRef.current.timer = null;
                                    }
                                    const jid = dcwJobRef.current.jobId;
                                    if (jid) {
                                      fetch(`/api/paylabs/dcw/run-paid/cancel`, {
                                        method: "POST",
                                        credentials: "include",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ jobId: jid }),
                                      }).catch(() => {});
                                    }
                                  }}
                                >
                                  Cancel
                                </button>
                              )}
                            </div>
                          )}
                          {msg.status === "error" && (
                            <div className="pl-error-msg">{msg.error || "Something went wrong."}</div>
                          )}
                          {msg.status === "done" && msg.result && (
                            <ResultCard result={msg.result} onReset={resetChat} />
                          )}
                        </div>
                      </div>
                    </div>
                  ),
                )}
              </div>
            )}

            <div className={`pl-input-row ${messages.length > 0 ? "sticky" : ""}`}>
              <textarea
                className="pl-prompt-input"
                placeholder="Ask about sources, payments, or creator attribution…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submitChat();
                  }
                }}
                rows={1}
              />
              <div className="pl-input-controls">
                <div className="pl-budget-row">
                  <label className="pl-budget-label">Budget</label>
                  <input
                    className="pl-budget-input"
                    type="text"
                    value={budget}
                    onChange={(e) => setBudget(e.target.value)}
                    placeholder="0.0001"
                  />
                  <span className="pl-budget-unit">USDC</span>
                </div>
                <button
                  type="button"
                  className="pl-submit-btn"
                  onClick={submitChat}
                  disabled={status === "running" || !prompt.trim()}
                >
                  {status === "running" ? "Running…" : "Ask"}
                </button>
              </div>
            </div>
          </div>
        </section>

        {result && messages.length === 0 && (
          <ResultCard result={result} onReset={resetChat} />
        )}

        {/* Guide section */}
        <section className="pl-guide-section">
          <button
            type="button"
            className="pl-guide-toggle"
            onClick={() => setGuideOpen(!guideOpen)}
          >
            <span>How PayLabs works</span>
            <span>{guideOpen ? "▾" : "▸"}</span>
          </button>
          {guideOpen && (
            <div className="pl-guide-content">
              <div className="pl-guide-step">
                <span className="pl-guide-num">1</span>
                <div>
                  <b>Ask a question</b>
                  <p>PayLabs discovers relevant sources using AI agents.</p>
                </div>
              </div>
              <div className="pl-guide-step">
                <span className="pl-guide-num">2</span>
                <div>
                  <b>Review sources</b>
                  <p>Sources are ranked by relevance and quality.</p>
                </div>
              </div>
              <div className="pl-guide-step">
                <span className="pl-guide-num">3</span>
                <div>
                  <b>Pay per source</b>
                  <p>x402 nanopayments go directly to creators via Circle Gateway.</p>
                </div>
              </div>
            </div>
          )}
        </section>
      </main>

      <DcwModal
        open={dcwOpen}
        onClose={() => setDcwOpen(false)}
        plannedCost={planned}
        onBalanceUpdate={(bal) => {
          setUcwBalance({
            walletUsdc: bal.walletUsdc,
            gatewayUsdc: bal.gatewayUsdc,
            pendingBatchUsdc: bal.pendingBatchUsdc,
            source: "dcw",
          });
        }}
        onWalletReady={async (w) => {
          setWalletInfo({
            address: w.address,
            walletType: "circle_developer_controlled",
            network: w.chain,
          });
          try {
            const dcwBal = await fetchDcwBalance();
            setUcwBalance(dcwBal);
            const x402Bal = parseFloat(dcwBal.gatewayUsdc ?? "0");
            setWalletState(x402Bal > 0 ? "ready_to_approve" : "needs_gateway_deposit");
          } catch {
            setWalletState("connected");
          }
          setDcwOpen(false);
        }}
      />
    </div>
  );
}

// ─── Result Card ────────────────────────────────────────────

function BrainIcon() {
  return (
    <svg className="pl-brain-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8.2 4.2C6.4 4.2 5 5.6 5 7.4c0 .2 0 .5.1.7A3.3 3.3 0 0 0 3.5 11c0 1.2.6 2.3 1.5 2.9v1.2c0 2 1.6 3.7 3.7 3.7 1.2 0 2.3-.6 3-1.5.7.9 1.8 1.5 3 1.5 2 0 3.7-1.6 3.7-3.7v-1.2c.9-.6 1.5-1.7 1.5-2.9 0-1.2-.6-2.3-1.6-2.9.1-.2.1-.5.1-.7 0-1.8-1.4-3.2-3.2-3.2-1.1 0-2.1.6-2.7 1.5-.6-.9-1.6-1.5-2.7-1.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.7 6v11.3M8.1 8.2c1.1 0 2 .9 2 2M8 14.4c1.2 0 2.1-.8 2.3-2M15.3 8.2c-1.1 0-2 .9-2 2M15.4 14.4c-1.2 0-2.1-.8-2.3-2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ResultCard({ result, onReset }: { result: SafeRunResult; onReset: () => void }) {
  const [rationaleOpen, setRationaleOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const rationaleText = result.userVisibleReasoning ?? result.brainRationale;
  return (
    <div className="pl-result-card">
      {result.assistantResponse && (
        <div className="pl-assistant-answer">{result.assistantResponse}</div>
      )}
      {result.sourcesUsed.length > 0 && (
        <div className="pl-source-links-row">
          {result.sourcesUsed.slice(0, 3).map((s, i) => (
            <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" title={s.title}>
              Link {i + 1}
            </a>
          ))}
        </div>
      )}
      {rationaleText && (
        <div className="pl-rationale-block">
          <button
            className="pl-rationale-toggle"
            onClick={() => setRationaleOpen(!rationaleOpen)}
          >
            <span className="pl-rationale-title">Reasoning</span>
            <span className="pl-rationale-caret">{rationaleOpen ? "▾" : "▸"}</span>
          </button>
          {rationaleOpen && (
            <pre className="pl-rationale-content">{rationaleText}</pre>
          )}
        </div>
      )}
      <div className="pl-rationale-block">
        <button
          className="pl-rationale-toggle"
          onClick={() => setDetailsOpen(!detailsOpen)}
        >
          <span className="pl-rationale-title">Run details</span>
          <span className="pl-rationale-caret">{detailsOpen ? "▾" : "▸"}</span>
        </button>
        {detailsOpen && (
          <div className="pl-result-grid">
            <div className="pl-result-pill">
              <span>Status</span>
              <b>{result.ok ? "Completed" : "Failed"}</b>
            </div>
            <div className="pl-result-pill">
              <span>Tier</span>
              <b style={{ textTransform: "capitalize" }}>{result.effectiveTier || result.tier || "—"}</b>
            </div>
            {result.requestedTier && result.requestedTier !== result.effectiveTier && (
              <div className="pl-result-pill">
                <span>Requested</span>
                <b style={{ textTransform: "capitalize" }}>{result.requestedTier}</b>
              </div>
            )}
            <div className="pl-result-pill">
              <span>Entry</span>
              <b style={{ textTransform: "capitalize" }}>{result.entryPaymentStatus || "—"}</b>
            </div>
            <div className="pl-result-pill">
              <span>Edges</span>
              <b>{result.paidEdges}/{result.totalEdges}</b>
            </div>
            <div className="pl-result-pill">
              <span>Cost</span>
              <b>{result.plannedCostUsdc != null ? `${result.plannedCostUsdc} USDC` : "—"}</b>
            </div>
            <div className="pl-result-pill">
              <span>Receipt</span>
              <b>{result.receiptReady ? "Ready" : "Pending"}</b>
            </div>
            {result.lockedNodes.length > 0 && (
              <div className="pl-result-pill">
                <span>Nodes</span>
                <b>{result.lockedNodes.join(" → ")}</b>
              </div>
            )}
          </div>
        )}
      </div>
      {(result.entryExplorerUrl || result.entryBatchExplorerUrl || result.entryBatchTxHash) && (
        <PaymentExplorerLinks
          directExplorerUrl={result.entryExplorerUrl}
          batchExplorerUrl={result.entryBatchExplorerUrl}
          batchTxHash={result.entryBatchTxHash}
          className="pl-payment-links-inline"
        />
      )}

      {result.entrySettlementId && !result.entryBatchExplorerUrl && !result.entryBatchTxHash && (
        <div className="pl-payment-links-inline" style={{ fontSize: "0.85em", opacity: 0.7, marginTop: 4 }}>
          ✓ Gateway accepted — queued for batch settlement
        </div>
      )}
      {result.runId && (
        <div className="pl-result-links">
          <a href={`/explorer?run=${result.runId}`}>View details</a>
          <button onClick={onReset} className="pl-new-run">New run</button>
        </div>
      )}
    </div>
  );
}
