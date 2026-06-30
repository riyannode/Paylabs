"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import SidebarPanel from "@/components/paylabs/SidebarPanel";
import MobileNav from "@/components/paylabs/MobileNav";
import type { WalletState, WalletInfo, UcwBalance } from "@/components/paylabs/WalletConnectModal";
import DcwModal from "@/components/paylabs/DcwModal";
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
  brainRouteTierHint: string | null;
  entryPaymentStatus: string | null;
  plannedCostUsdc: number | null;
  paidEdges: number;
  totalEdges: number;
  receiptReady: boolean;
  safeSummary: string;
  assistantResponse: string | null;
  userVisibleReasoning: string | null;
  brainRationale: string | null;
  sourceFinalAnswer: string | null;
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
  const [ucwBalance, setUcwBalance] = useState<UcwBalance | null>(null);
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
      window.location.replace(`/creator-dashboard${hash}`);
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
            setUcwBalance(dcwBal);
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
        setWalletModeError("Creator Wallet is connected. Disconnect it before connecting User Test Wallet.");
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
    if (ucwBalance) {
      const x402Bal = parseFloat(ucwBalance.gatewayUsdc ?? "0");
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
  }, [prompt, budget, walletInfo, ucwBalance, planned, openDcwWalletModal]);

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
    setUcwBalance(null);
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

  return (
    <>
      <MobileNav />
    <div className="pl-app">
      <SidebarPanel analytics={analytics} />

      <main className="pl-main">
        <div className="pl-topbar">
          <div />

          <button
            type="button"
            className={`pl-wallet-pill ${walletInfo?.address ? "connected" : ""}`}
            onClick={openDcwWalletModal}
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
                {walletInfo?.walletType === "circle_developer_controlled" && (
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
                )}
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

        {walletModeError && (
          <div className="pl-wallet-error-v3" style={{ margin: "8px 0" }}>
            {walletModeError}
          </div>
        )}

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
                              {/* Cancel button removed — DCW paid flow is now synchronous */}
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
              <span>Route guide</span>
              <span>{guideOpen ? "▾" : "▸"}</span>
            </button>
            {guideOpen && (
              <div className="pl-guide-rows">
                <div className="pl-guide-row">
                  <div className="pl-guide-info">
                    <b>Easy</b>
                    <span>Best for: Quick answer</span>
                    <span className="pl-guide-example">Explain Arc x402 simply using source-backed info.</span>
                  </div>
                  <button className="pl-guide-use" onClick={() => setPrompt("Explain Arc x402 simply using source-backed info.")}>Use</button>
                </div>
                <div className="pl-guide-row">
                  <div className="pl-guide-info">
                    <b>Normal</b>
                    <span>Best for: Compare / verify</span>
                    <span className="pl-guide-example">Compare Arc x402 and Circle Gateway and verify the main claims.</span>
                  </div>
                  <button className="pl-guide-use" onClick={() => setPrompt("Compare Arc x402 and Circle Gateway and verify the main claims.")}>Use</button>
                </div>
                <div className="pl-guide-row">
                  <div className="pl-guide-info">
                    <b>Advanced</b>
                    <span>Best for: Paid source / receipt</span>
                    <span className="pl-guide-example">Use advanced route, unlock paid or creator-monetized sources if needed, and return receipt confirmation.</span>
                  </div>
                  <button className="pl-guide-use" onClick={() => setPrompt("Use advanced route, unlock paid or creator-monetized sources if needed, and return receipt confirmation.")}>Use</button>
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
        }}
      />
    </div>
    </>
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
  const [sourceSummaryOpen, setSourceSummaryOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Filter out generic processing text from route reasoning
  const GENERIC_PATTERNS = [
    /i am processing/i, /i will gather/i, /saya sedang memproses/i,
    /processing your request/i, /gathering information/i, /searching for/i,
    /i'll look/i, /let me find/i, /memproses permintaan/i,
  ];
  const isGenericText = (text: string | null): boolean =>
    !!text && GENERIC_PATTERNS.some((p) => p.test(text)) && text.length < 120;
  const rationaleCandidates = [result.brainRationale, result.userVisibleReasoning].filter(Boolean) as string[];
  const rationaleText = rationaleCandidates.find((text) => !isGenericText(text)) ?? null;
  return (
    <div className="pl-result-card">
      {result.assistantResponse && (
        <div className="pl-assistant-answer">
          <div className="pl-assistant-label">Answer</div>
          <div>{result.assistantResponse}</div>
        </div>
      )}
      {rationaleText && (
        <div className="pl-rationale-block">
          <button
            className="pl-rationale-toggle"
            onClick={() => setRationaleOpen(!rationaleOpen)}
            type="button"
          >
            <span className="pl-rationale-title">Route reasoning</span>
            <span className="pl-rationale-caret">{rationaleOpen ? "▾" : "▸"}</span>
          </button>
          {rationaleOpen && (
            <div className="pl-rationale-content">{rationaleText}</div>
          )}
        </div>
      )}
      {result.sourceFinalAnswer && result.sourceFinalAnswer !== result.assistantResponse && (
        <div className="pl-source-summary-pill-wrap">
          <button
            className="pl-source-summary-pill"
            onClick={() => setSourceSummaryOpen(!sourceSummaryOpen)}
            type="button"
          >
            <span>Source summary</span>
            <span>{sourceSummaryOpen ? "▾" : "▸"}</span>
          </button>
          {sourceSummaryOpen && (
            <div className="pl-source-summary-content">{result.sourceFinalAnswer}</div>
          )}
        </div>
      )}
      {result.sourcesUsed.length > 0 && (
        <div className="pl-source-links-row">
          {result.sourcesUsed.slice(0, 3).map((s, i) => (
            <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" title={s.title}>
              Link {i + 1}
              <span className="pl-source-link-meta">{s.title || s.domain || ""}</span>
            </a>
          ))}
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
            {result.requestedTier && (
              <div className="pl-result-pill">
                <span>Requested</span>
                <b style={{ textTransform: "capitalize" }}>{result.requestedTier}</b>
              </div>
            )}
            {result.brainRouteTierHint && (
              <div className="pl-result-pill">
                <span>Brain selected</span>
                <b style={{ textTransform: "capitalize" }}>{result.brainRouteTierHint}</b>
              </div>
            )}
            {result.tierDecisionReason && (
              <div className="pl-result-pill">
                <span>Why</span>
                <b>{result.tierDecisionReason}</b>
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
      {result.entrySettlementId && !result.entryBatchExplorerUrl && !result.entryBatchTxHash && (
        <div className="pl-payment-links-inline" style={{ fontSize: "0.85em", opacity: 0.7, marginTop: 4 }}>
          ✓ Gateway accepted — queued for batch settlement
        </div>
      )}
      {result.runId && (
        <div className="pl-result-links">
          <a href={`/receipts?run=${result.runId}`}>View receipt</a>
          <a href={`/explorer?run=${result.runId}`}>View details</a>
          <button onClick={onReset} className="pl-new-run">New run</button>
        </div>
      )}
    </div>
  );
}
