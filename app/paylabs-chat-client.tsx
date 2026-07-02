"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import SidebarPanel from "@/components/paylabs/SidebarPanel";
import MobileNav from "@/components/paylabs/MobileNav";
import type { WalletState, WalletInfo, PayLabsWalletBalance } from "@/components/paylabs/wallet-types";
import DcwModal from "@/components/paylabs/DcwModal";
import { safeExplorerUrl as validateExplorerUrl } from "@/lib/paylabs/x402/payment-links";
import type { SafeRunResult, SourceLink, ChatMessage } from "@/components/paylabs/chat/types";
import { BrainIcon } from "@/components/paylabs/chat/BrainIcon";
import { ChatResultCard } from "@/components/paylabs/chat/ChatResultCard";
import { ChatTypingIndicator } from "@/components/paylabs/chat/ChatTypingIndicator";
import { ChatErrorDisplay } from "@/components/paylabs/chat/ChatErrorDisplay";
import { WalletPill } from "@/components/paylabs/chat/WalletPill";

// ─── Types ──────────────────────────────────────────────────

type Analytics = {
  uniqueUsers: number;
  active24h: number;
  active7d: number;
};

type Props = {
  analytics: Analytics;
};

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

// Planned cost comes from backend /api/paylabs/quote. No frontend constants.

function toSafeRunResult(data: Record<string, unknown>): SafeRunResult {
  const paymentGraph =
    (data?.payment_graph as unknown[]) ??
    ((data?.result as Record<string, unknown>)?.paymentGraph as unknown[]) ??
    ((data?.agent_trace as Record<string, unknown>)?.payment_graph as unknown[]) ??
    ((data?.exit_output as Record<string, unknown>)?.payment_graph as unknown[]) ??
    [];
  const paidEdges = Array.isArray(paymentGraph)
    ? paymentGraph.filter((e: unknown) => (e as Record<string, string>).status === "paid").length
    : 0;
  const exitOutput = data?.exit_output as Record<string, unknown> | undefined;
  const quote = data?.quote as Record<string, unknown> | undefined;
  const tieredSummaries = data?.tiered_summaries as Record<string, string> | undefined;
  const brainPlanning = data?.brain_planning as Record<string, unknown> | undefined;
  const agentTraceBrain = (data?.agent_trace as Record<string, unknown>)?.brain_planning as Record<string, unknown> | undefined;

  const rawFinalAnswer =
    (data?.final_answer as string) ??
    (exitOutput?.final_answer as string) ??
    null;

  // Prioritize Brain LLM answer over deterministic source-grounded answer.
  // brainAssistantResponse is a natural LLM answer; rawFinalAnswer is a deterministic source list.
  const isNoSourceFallback = /no sufficiently relevant sources found|no relevant sources found|no matching live rsshub sources|no sufficiently relevant live sources were found|did not attach source links/i.test(rawFinalAnswer || "");
  const brainAssistantResponse =
    (brainPlanning?.assistant_response as string) ??
    (agentTraceBrain?.assistant_response as string) ??
    (brainPlanning?.plan_rationale as string) ??
    (agentTraceBrain?.plan_rationale as string) ??
    null;

  // Block generic Brain planning text from being shown as the Answer
  // Anchored to sentence-start or preceded by planning indicators to avoid
  // matching legitimate answers like "binary searching for" or "looking for jobs"
  const GENERIC_ANSWER_RE = /^(i will find|i will search|i am processing|let me find|i'll look|i'll search|saya akan mencari|saya sedang memproses|mohon tunggu sebentar|gathering information|i'm searching for|i'm looking for|saya sedang mencari)/i;
  const isGenericBrainAnswer = !!brainAssistantResponse && GENERIC_ANSWER_RE.test(brainAssistantResponse) && brainAssistantResponse.length < 200;

  const NO_SOURCE_FALLBACK_MSG = "No sufficiently relevant live sources were found for this query. The route completed with basic discovery, but PayLabs did not attach source links because no source passed the relevance gate.";

  const assistantResponse =
    (brainAssistantResponse && !isGenericBrainAnswer ? brainAssistantResponse : null) ??
    (rawFinalAnswer && !isNoSourceFallback ? rawFinalAnswer : null) ??
    (isNoSourceFallback || isGenericBrainAnswer ? NO_SOURCE_FALLBACK_MSG : null) ??
    (exitOutput?.final_summary as string) ??
    tieredSummaries?.final_summary ??
    "Run completed.";
  const userVisibleReasoning =
    (brainPlanning?.user_visible_reasoning as string) ??
    (agentTraceBrain?.user_visible_reasoning as string) ??
    null;
  // Route reasoning priority: user_visible_reasoning first (detailed explanation), then tier_decision_reason (short)
  const brainRationale =
    (brainPlanning?.user_visible_reasoning as string) ??
    (agentTraceBrain?.user_visible_reasoning as string) ??
    (brainPlanning?.tier_decision_reason as string) ??
    (agentTraceBrain?.tier_decision_reason as string) ??
    (brainPlanning?.plan_rationale as string) ??
    (agentTraceBrain?.plan_rationale as string) ??
    null;

  // Extract sources from source_context.sources_used or fallback to exit_output.sources_used
  const sourceContext = data?.source_context as Record<string, unknown> | undefined;
  const rawSources: unknown[] =
    (sourceContext?.sources_used as unknown[]) ??
    (exitOutput?.sources_used as unknown[]) ??
    [];
  const sourcesUsed: SourceLink[] = Array.isArray(rawSources)
    ? rawSources
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
        .map((s) => {
          const url = typeof s.url === "string" ? s.url : "";
          const title = typeof s.title === "string" && s.title ? s.title : null;
          let domain: string | null = typeof s.domain === "string" ? s.domain : null;
          if (!domain && url) {
            try { domain = new URL(url).hostname; } catch { /* noop */ }
          }
          return {
            title: title || domain || "Source",
            url,
            domain,
            summary: typeof s.summary === "string" ? s.summary : "",
            rank: typeof s.rank === "number" ? s.rank : 0,
            relevance_score: typeof s.relevance_score === "number" ? s.relevance_score : 0,
          };
        })
        .filter((s) => /^https?:\/\//.test(s.url))
    : [];

  // Extract entry payment link fields (safe URLs only, never settlement UUID)
  const entryPayment = data?.entry_payment as Record<string, unknown> | undefined;
  const agentTrace = data?.agent_trace as Record<string, unknown> | undefined;
  const agentTraceEntry = agentTrace?.entry_payment as Record<string, unknown> | undefined;
  const resolvedEntry = entryPayment ?? agentTraceEntry;
  const paymentMetadata = data?.paymentMetadata as Record<string, unknown> | undefined;

  return {
    ok: !!data?.ok,
    runId: (data?.discovery_run_id as string) ?? (data?.id as string) ?? null,
    status: (data?.status as string) ?? null,
    requestedTier: (data?.requested_route_tier as string) ?? null,
    tier: (data?.effective_route_tier as string) ?? (data?.route_tier as string) ?? null,
    effectiveTier: (data?.effective_route_tier as string) ?? (data?.route_tier as string) ?? null,
    brainRouteTierHint: (data?.brain_route_tier_hint as string) ?? (brainPlanning?.route_tier_hint as string) ?? null,
    entryPaymentStatus: (data?.entry_payment as Record<string, string>)?.status ?? null,
    plannedCostUsdc: (quote?.plannedCostUsdc as number) ?? (exitOutput?.planned_cost_usdc as number) ?? null,
    paidEdges,
    totalEdges: Array.isArray(paymentGraph) ? paymentGraph.length : 0,
    receiptReady: (data?.receipt_ready as boolean) ?? (exitOutput?.receipt_ready as boolean) ?? false,
    safeSummary: (exitOutput?.final_summary as string) ?? tieredSummaries?.final_summary ?? "Run completed.",
    assistantResponse,
    userVisibleReasoning,
    brainRationale,
    sourceFinalAnswer: rawFinalAnswer,
    lockedNodes: ((data?.locked_execution_plan as Record<string, unknown>)?.selected_macro_nodes as string[]) ?? [],
    lockedServices: ((data?.locked_execution_plan as Record<string, unknown>)?.selected_services as string[]) ?? [],
    tierDecisionReason: (brainPlanning?.tier_decision_reason as string) ?? null,
    sourcesUsed,
    entryExplorerUrl:
      validateExplorerUrl(resolvedEntry?.explorer_url) ??
      validateExplorerUrl(data?.entry_payment_explorer_url) ??
      validateExplorerUrl(paymentMetadata?.explorerUrl),

    entrySettlementId:
      (resolvedEntry?.settlement_id as string | null | undefined) ??
      (data?.entry_payment_settlement_id as string | null | undefined) ??
      (paymentMetadata?.settlementId as string | null | undefined) ??
      null,

    entryTransferStatus:
      (resolvedEntry?.transfer_status as string | null | undefined) ??
      (paymentMetadata?.transferStatus as string | null | undefined) ??
      null,

    entryGatewayAccepted:
      (resolvedEntry?.gateway_accepted as boolean | undefined) ??
      (paymentMetadata?.gatewayAccepted as boolean | undefined) ??
      false,

    entryBatchExplorerUrl:
      validateExplorerUrl(resolvedEntry?.batch_explorer_url) ??
      validateExplorerUrl(data?.entry_payment_batch_explorer_url) ??
      validateExplorerUrl(paymentMetadata?.batchExplorerUrl),

    entryBatchTxHash:
      (resolvedEntry?.batch_tx_hash as string | null | undefined) ??
      (paymentMetadata?.batchTxHash as string | null | undefined) ??
      null,
  };
}

/** Fetch DCW balance — on-chain wallet USDC + Gateway x402 balance */
async function fetchDcwBalance(): Promise<PayLabsWalletBalance> {
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


async function hasActiveCreatorWalletSession() {
  const resp = await fetch("/api/paylabs/wallet/ucw?action=session-restore", {
    method: "POST",
    credentials: "include",
  });

  if (!resp.ok) return false;

  const data = await resp.json().catch(() => ({}));
  return !!data?.hasUserToken && !!data?.walletAddress;
}

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

  // ── Batch link polling ──────────────────────────────────────
  // When settlementId exists but batch link is missing, poll the
  // batch resolver endpoint until the link appears or we give up.
  const batchPollRef = useRef<{ attempts: number; timer: ReturnType<typeof setTimeout> | null }>({ attempts: 0, timer: null });
  // dcwJobRef removed — DCW paid flow is now synchronous (request-bound)


  useEffect(() => {
    const r = result;
    if (!r?.entrySettlementId) return;
    if (r.entryBatchExplorerUrl || r.entryBatchTxHash) return;
    if (batchPollRef.current.timer) return; // already polling

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
          return; // stop polling
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

  // Chat message history
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const chatThreadRef = useRef<HTMLDivElement | null>(null);

  // Wallet state — DCW only
  const [dcwOpen, setDcwOpen] = useState(false);
  const [walletState, setWalletState] = useState<WalletState>("not_connected");
  const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [walletModeError, setWalletModeError] = useState<string | null>(null);
  const [dcwBalance, setDcwBalance] = useState<PayLabsWalletBalance | null>(null);
  const [walletCopied, setWalletCopied] = useState(false);

  // Debug log — gated behind env var, stripped from production
  const dcwDebug = process.env.NEXT_PUBLIC_PAYLABS_UCW_DEBUG === "1";
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const dbg = useCallback((msg: string) => {
    if (!dcwDebug) return;
    const ts = new Date().toISOString().slice(11, 23);
    const entry = `[${ts}] ${msg}`;
    console.log("[DCW]", entry);
    setDebugLog((prev) => [...prev.slice(-20), entry]);
  }, [dcwDebug]);

  // Backend-driven planned cost (replaces hardcoded TIER_COSTS)
  const [plannedCostUsdc, setPlannedCostUsdc] = useState<number>(0.000015); // conservative default (advanced tier)
  const [quoteRouteTier, setQuoteRouteTier] = useState<string>("advanced");

  const planned = useMemo(() => plannedCostUsdc.toFixed(6), [plannedCostUsdc]);

  // Fetch quote from backend when budget or tier changes
  useEffect(() => {
    const tier = /* routeTier state or */ "auto";
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

  // ── Defensive: redirect UCW OAuth callback to /creator-dashboard ──
  // If Google/Circle OAuth returns to root "/" with hash material,
  // redirect to /creator-dashboard so the UCW hook can process the callback.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (
      window.location.pathname === "/" &&
      (hash.includes("access_token") || hash.includes("id_token") || hash.includes("error"))
    ) {
      window.location.replace(`/creator-profile${hash}`);
    }
  }, []);

  // ── Post-redirect: restore SDK from server session ──
  useEffect(() => {
    let cancelled = false;
    const restoreAfterRedirect = async () => {
      dbg("restoreAfterRedirect: start");

      // ── DCW session restore (check first — no SDK needed) ──
      try {
        const dcwSessionResp = await fetch("/api/paylabs/auth/session", { credentials: "include" });
        if (dcwSessionResp.ok) {
          const dcwSession = await dcwSessionResp.json();
          if (dcwSession.ok && dcwSession.authenticated && dcwSession.hasWallet && dcwSession.walletAddress) {
            dbg("DCW session found — restoring wallet state");
            setWalletInfo({
              address: dcwSession.walletAddress,
              walletType: "circle_developer_controlled",
              network: "ARC-TESTNET",
            });
            const dcwBal = await fetchDcwBalance();
            setDcwBalance(dcwBal);
            const x402Bal = parseFloat(dcwBal.gatewayUsdc ?? "0");
            setWalletState(x402Bal > 0 ? "ready_to_approve" : "needs_gateway_deposit");
            return; // DCW session restored
          }
        }
      } catch { /* no DCW session */ }

    };
    restoreAfterRedirect();

    return () => {
      cancelled = true;
    };
  }, [planned]);


  const openDcwWalletModal = useCallback(async () => {
    setWalletModeError(null);

    try {
      const ucwActive = await hasActiveCreatorWalletSession();
      if (ucwActive) {
        setWalletModeError("Creator Wallet is connected. Disconnect it before connecting PayLabs Payment Wallet.");
        return;
      }
    } catch {
      // Fail open for network/read errors; backend session guards still apply.
    }

    setDcwOpen(true);
  }, []);

  // ── Submit chat ──
  const submitChat = useCallback(async () => {
    if (!prompt.trim()) return;

    // Run gating: must have wallet
    if (!walletInfo?.address) {
      openDcwWalletModal();
      return;
    }

    // Run gating: must have sufficient x402 Balance for planned cost
    if (dcwBalance) {
      const x402Bal = parseFloat(dcwBalance.gatewayUsdc ?? "0");
      const costNum = parseFloat(planned);
      if (x402Bal < costNum) {
        // Insufficient x402 balance — open DCW modal with top-up tab
        openDcwWalletModal();
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

    const body = {
      goal: userMsg.content,
      user_wallet: walletInfo.address,
      route_tier: "auto",
      budget_usdc: Number(budget),
      customer_wallet_type: walletInfo.walletType,
    };

    try {
      // ── DCW: bypass inline entirely, go straight to server-side run-paid ──
      if (walletInfo.walletType === "circle_developer_controlled") {
        setWalletState("approving");
         setSigningPhase("Starting DCW payment…");
         // ── Synchronous: POST waits for full x402 flow, returns final result ──
         try {
           const dcwResp = await fetch("/api/paylabs/dcw/run-paid", {
             method: "POST",
             credentials: "include",
             headers: { "Content-Type": "application/json" },
             body: JSON.stringify({
               goal: body.goal || prompt,
               routeTier: body.route_tier || "auto",
               budgetUsdc: Number(budget),
             }),
           });
           const dcwData = await dcwResp.json();
           // Check both top-level transport ok AND nested seller result ok
           const sellerData = dcwData.data && typeof dcwData.data === "object"
             ? (dcwData.data as Record<string, unknown>)
             : null;
           const sellerOk = sellerData ? (sellerData.ok !== false) : true;
           if (!dcwResp.ok || !dcwData.ok || !sellerOk) {
             const errMsg = (sellerData?.error as string) || dcwData.error || `DCW payment failed (HTTP ${dcwResp.status})`;
             setSigningPhase(null);
             finishAssistant({ status: "error", error: errMsg });
             setError(errMsg);
             setWalletState("failed");
             setStatus("error");
             return;
           }
           // ── Success — parse result ──
           setSigningPhase(null);
           const dcwResultData =
             dcwData.data && typeof dcwData.data === "object"
               ? (dcwData.data as Record<string, unknown>)
               : {};
           const safeResult = toSafeRunResult({
             ...dcwResultData,
             entry_payment: dcwData.entry_payment ?? dcwResultData.entry_payment,
             paymentMetadata: dcwData.paymentMetadata ?? dcwResultData.paymentMetadata,
             entry_payment_explorer_url:
               dcwData.entry_payment?.explorer_url ??
               dcwData.paymentMetadata?.explorerUrl ??
               dcwResultData.entry_payment_explorer_url ??
               null,
             entry_payment_batch_explorer_url:
               dcwData.entry_payment?.batch_explorer_url ??
               dcwData.paymentMetadata?.batchExplorerUrl ??
               dcwResultData.entry_payment_batch_explorer_url ??
               null,
           });
           setWalletState("paid");
           finishAssistant({ status: "done", result: safeResult });
           setResult(safeResult);
           setStatus("done");
           return;
         } catch (e: unknown) {
           const errMsg = e instanceof Error ? e.message : "DCW payment request failed.";
           setSigningPhase(null);
           finishAssistant({ status: "error", error: errMsg });
           setError(errMsg);
           setWalletState("failed");
           setStatus("error");
           return;
         }
       }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : "Network error.";
      finishAssistant({ status: "error", error: errMsg });
      setError(errMsg);
      setStatus("error");
    }
  }, [prompt, budget, walletInfo, dcwBalance, planned, openDcwWalletModal]);

  const resetChat = useCallback(() => {
    setPrompt("");
    setResult(null);
    setError(null);
    setStatus("idle");
    setMessages([]);
  }, []);

  // ── Disconnect wallet ──
  const disconnectWallet = useCallback(() => {
    // Destroy DCW session if exists
    fetch("/api/paylabs/auth/session", { method: "DELETE", credentials: "include" }).catch(() => {});
    // Clear all wallet state
    setWalletInfo(null);
    setWalletState("not_connected");
    setDcwBalance(null);
    setWalletError(null);
  }, []);

  // Dev mode: show EOA fallback if ?eoa=1 in URL
  const showEoaFallback = typeof window !== "undefined" && window.location.search.includes("eoa=1");

  // Reconnect — chat is DCW-only, just open DcwModal
  const reconnectByAuth = useCallback(() => {
    openDcwWalletModal();
  }, [openDcwWalletModal]);

  const copyWalletAddress = useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!walletInfo?.address) return;
    try {
      await navigator.clipboard?.writeText(walletInfo.address);
      setWalletCopied(true);
      window.setTimeout(() => setWalletCopied(false), 1200);
    } catch {
      setWalletError("Could not copy wallet address.");
    }
  }, [walletInfo?.address]);

  const handleRefreshBalance = useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    try {
      const dcwBal = await fetchDcwBalance();
      setDcwBalance(dcwBal);
    } catch { /* refresh failed */ }
  }, []);

  const handleDisconnectWalletClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    disconnectWallet();
  }, [disconnectWallet]);

  return (
    <>
      <MobileNav />
    <div className="pl-app">
      <SidebarPanel analytics={analytics} />

      <main className="pl-main">
        <div className="pl-topbar">
          <div />

          <WalletPill
            walletInfo={walletInfo}
            dcwBalance={dcwBalance}
            walletCopied={walletCopied}
            shortAddress={short}
            onOpenWallet={openDcwWalletModal}
            onRefreshBalance={handleRefreshBalance}
            onCopyAddress={copyWalletAddress}
            onDisconnect={handleDisconnectWalletClick}
          />
        </div>

        {walletModeError && (
          <div className="pl-wallet-error-v3" style={{ margin: "8px 0" }}>
            {walletModeError}
          </div>
        )}

        <section className="pl-hero">
          <h1>AI search that <span style={{ color: "var(--info)" }}>pays creators</span>.</h1>
          <p>PayLabs finds answers with AI and pays verified creators when their sources are used.</p>

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
                            <ChatTypingIndicator signingPhase={signingPhase} />
                          )}
                          {msg.status === "error" && (
                            <ChatErrorDisplay error={msg.error || "Something went wrong."} />
                          )}
                          {msg.status === "done" && msg.result && (
                            <ChatResultCard result={msg.result} onReset={resetChat} />
                          )}
                        </div>
                      </div>
                    </div>
                  ),
                )}
              </div>
            )}

            <div className="pl-chat-composer">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Ask for a route, receipt, or source-backed payment…"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submitChat();
                  }
                }}
              />
              <div className="pl-search-actions">
                <span className="pl-x402-badge">x402 protected</span>
                <button
                  className="pl-run-btn"
                  onClick={submitChat}
                  disabled={status === "running" || !prompt.trim()}
                >
                  {status === "running" ? "…" : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>}
                </button>
              </div>
            </div>
          </div>

          <div className="pl-guide-block">
            <button
              className="pl-guide-toggle"
              onClick={() => setGuideOpen(!guideOpen)}
            >
              <span>Route guide — Brain auto routes by task complexity</span>
              <span>{guideOpen ? "▾" : "▸"}</span>
            </button>
            {guideOpen && (
              <div className="pl-guide-rows">
                <div className="pl-guide-row">
                  <div className="pl-guide-info">
                    <b>Quick answer</b>
                    <span>Best for: Explain, define, summarize</span>
                    <span className="pl-guide-example">Explain Arc x402 simply using source-backed info.</span>
                  </div>
                  <button className="pl-guide-use" onClick={() => setPrompt("Explain Arc x402 simply using source-backed info.")}>Use</button>
                </div>
                <div className="pl-guide-row">
                  <div className="pl-guide-info">
                    <b>Standard research</b>
                    <span>Best for: Compare, verify, fact-check</span>
                    <span className="pl-guide-example">Compare Arc x402 and Circle Gateway and verify the main claims.</span>
                  </div>
                  <button className="pl-guide-use" onClick={() => setPrompt("Compare Arc x402 and Circle Gateway and verify the main claims.")}>Use</button>
                </div>
                <div className="pl-guide-row">
                  <div className="pl-guide-info">
                    <b>Deep research</b>
                    <span>Best for: Multi-source, current, attribution</span>
                    <span className="pl-guide-example">What are the latest developments in open source AI agent frameworks, compare the strongest projects, verify with multiple current sources, and show which sources influenced the answer?</span>
                  </div>
                  <button className="pl-guide-use" onClick={() => setPrompt("What are the latest developments in open source AI agent frameworks, compare the strongest projects, verify with multiple current sources, and show which sources influenced the answer?")}>Use</button>
                </div>
              </div>
            )}
          </div>
        </section>
      </main>

      <DcwModal
        open={dcwOpen}
        onClose={() => setDcwOpen(false)}
        plannedCost={planned}
        onBalanceUpdate={(bal) => {
          setDcwBalance({
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
            setDcwBalance(dcwBal);
            const x402Bal = parseFloat(dcwBal.gatewayUsdc ?? "0");
            setWalletState(x402Bal > 0 ? "ready_to_approve" : "needs_gateway_deposit");
          } catch {
            setWalletState("connected");
          }
        }}
      />
    </div>
    </>
  );
}
