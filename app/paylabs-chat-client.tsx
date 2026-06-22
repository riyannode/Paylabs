"use client";

import { useMemo, useState, useCallback } from "react";
import SidebarPanel from "@/components/paylabs/SidebarPanel";
import WalletConnectModal from "@/components/paylabs/WalletConnectModal";
import type { WalletState, WalletInfo } from "@/components/paylabs/WalletConnectModal";

// ─── Types ──────────────────────────────────────────────────

type Analytics = {
  uniqueUsers: number;
  active24h: number;
  active7d: number;
  topWallet?: { address: string; runs: number } | null;
};

type ExplorerRun = {
  id: string;
  route_tier: string | null;
  status: string | null;
  paid_edges: number;
  user_wallet: string | null;
  created_at: string | null;
};

type FeedItem = {
  id: string;
  title: string | null;
  publisher: string | null;
  author_name: string | null;
  canonical_url: string | null;
  is_monetized: boolean | null;
};

type SafeRunResult = {
  ok: boolean;
  runId: string | null;
  status: string | null;
  tier: string | null;
  entryPaymentStatus: string | null;
  plannedCostUsdc: number | null;
  paidEdges: number;
  totalEdges: number;
  receiptReady: boolean;
  safeSummary: string;
};

type Props = {
  analytics: Analytics;
  explorerRuns: ExplorerRun[];
  feedItems: FeedItem[];
};

// ─── Helpers ────────────────────────────────────────────────

function short(value?: string | null, chars = 6): string {
  if (!value) return "—";
  if (value.length <= chars * 2 + 3) return value;
  return `${value.slice(0, chars)}…${value.slice(-chars)}`;
}

const TIER_COSTS: Record<string, string> = {
  easy: "0.000007",
  normal: "0.000013",
  advanced: "0.000015",
};

function toSafeRunResult(data: Record<string, unknown>): SafeRunResult {
  const paymentGraph =
    (data?.payment_graph as unknown[]) ??
    (data?.result as Record<string, unknown>)?.paymentGraph as unknown[] ??
    (data?.agent_trace as Record<string, unknown>)?.payment_graph as unknown[] ??
    (data?.exit_output as Record<string, unknown>)?.payment_graph as unknown[] ??
    [];

  const paidEdges = Array.isArray(paymentGraph)
    ? paymentGraph.filter((e: unknown) => (e as Record<string, string>).status === "paid").length
    : 0;

  const exitOutput = data?.exit_output as Record<string, unknown> | undefined;
  const quote = data?.quote as Record<string, unknown> | undefined;

  return {
    ok: !!data?.ok,
    runId: (data?.discovery_run_id as string) ?? (data?.id as string) ?? null,
    status: (data?.status as string) ?? null,
    tier: (data?.route_tier as string) ?? null,
    entryPaymentStatus: (data?.entry_payment as Record<string, string>)?.status ?? null,
    plannedCostUsdc: (quote?.plannedCostUsdc as number) ?? (exitOutput?.planned_cost_usdc as number) ?? null,
    paidEdges,
    totalEdges: Array.isArray(paymentGraph) ? paymentGraph.length : 0,
    receiptReady: (data?.receipt_ready as boolean) ?? (exitOutput?.receipt_ready as boolean) ?? false,
    safeSummary:
      (exitOutput?.final_summary as string) ??
      (data?.tiered_summaries as Record<string, string>)?.final_summary ??
      "Run completed.",
  };
}

// ─── x402 Client Signing (EOA) ─────────────────────────────

const ARC_CHAIN_ID = 5042002;
const GATEWAY_VERIFIED_CONTRACT = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";

function randomNonce(): `0x${string}` {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return `0x${Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

async function signWithEoa(params: {
  challenge: Record<string, unknown>;
  walletAddress: string;
}): Promise<string> {
  const { challenge, walletAddress } = params;
  const accepts = challenge.accepts as Array<Record<string, unknown>>;
  const requirement = accepts[0];
  const extra = requirement.extra as Record<string, string>;
  const amountAtomic = requirement.amount as string;
  const payTo = requirement.payTo as string;
  const maxTimeout = requirement.maxTimeoutSeconds as number;

  const now = Math.floor(Date.now() / 1000);
  const nonce = randomNonce();

  // EIP-712 domain
  const domain = {
    name: extra.name || "GatewayWalletBatched",
    version: extra.version || "1",
    chainId: ARC_CHAIN_ID,
    verifyingContract: (extra.verifyingContract || GATEWAY_VERIFIED_CONTRACT) as `0x${string}`,
  };

  // EIP-712 types
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };

  const message = {
    from: walletAddress as `0x${string}`,
    to: payTo as `0x${string}`,
    value: BigInt(amountAtomic),
    validAfter: BigInt(0),
    validBefore: BigInt(now + maxTimeout),
    nonce,
  };

  // Use window.ethereum (injected provider)
  const eth = (window as unknown as Record<string, unknown>).ethereum as
    | { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }
    | undefined;
  if (!eth) throw new Error("No browser wallet found. Install MetaMask or similar.");

  // Request accounts
  const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
  if (!accounts || accounts.length === 0) {
    throw new Error("Wallet is locked. Please unlock and try again.");
  }

  // Sign typed data v4
  const signature = await (eth as { request: (args: { method: string; params: unknown[] }) => Promise<string> }).request({
    method: "eth_signTypedData_v4",
    params: [
      walletAddress,
      JSON.stringify({
        types: { EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ], ...types },
        domain,
        primaryType: "TransferWithAuthorization",
        message,
      }),
    ],
  });

  // Build payment payload per x402-batching spec
  const x402Version = (challenge.x402Version as number) || 2;
  const paymentPayload = {
    x402Version,
    payload: {
      authorization: {
        from: message.from,
        to: message.to,
        value: message.value.toString(),
        validAfter: message.validAfter.toString(),
        validBefore: message.validBefore.toString(),
        nonce: message.nonce,
      },
      signature,
    },
    resource: challenge.resource || null,
    accepted: requirement,
  };

  // Base64 encode
  return btoa(JSON.stringify(paymentPayload));
}

// ─── Main Component ─────────────────────────────────────────

export default function PayLabsChatClient({ analytics, explorerRuns, feedItems }: Props) {
  // Chat state
  const [prompt, setPrompt] = useState("");
  const [tier, setTier] = useState<"easy" | "normal" | "advanced">("easy");
  const [budget, setBudget] = useState("0.02");
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SafeRunResult | null>(null);

  // Wallet state
  const [walletOpen, setWalletOpen] = useState(false);
  const [walletState, setWalletState] = useState<WalletState>("not_connected");
  const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);

  const planned = useMemo(() => TIER_COSTS[tier] || "0.000007", [tier]);

  // ── Connect EOA wallet ──
  const connectEoa = useCallback(async () => {
    setWalletState("connecting");
    setWalletError(null);
    try {
      const eth = (window as unknown as Record<string, unknown>).ethereum as
        | { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }
        | undefined;
      if (!eth) {
        setWalletState("not_connected");
        setWalletError("No browser wallet found. Install MetaMask or similar.");
        return;
      }
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      if (!accounts || accounts.length === 0) {
        setWalletState("not_connected");
        setWalletError("Wallet connection rejected.");
        return;
      }
      setWalletInfo({
        address: accounts[0],
        walletType: "external_eoa",
        network: "Arc Testnet",
      });
      setWalletState("ready_to_approve");
    } catch (e: unknown) {
      setWalletState("not_connected");
      setWalletError(e instanceof Error ? e.message : "Connection failed.");
    }
  }, []);

  // ── Submit chat ──
  const submitChat = useCallback(async () => {
    if (!prompt.trim()) return;

    if (!walletInfo?.address) {
      setWalletOpen(true);
      return;
    }

    setStatus("running");
    setError(null);
    setResult(null);

    const body = {
      goal: prompt.trim(),
      user_wallet: walletInfo.address,
      route_tier: tier,
      budget_usdc: Number(budget),
      customer_wallet_type: walletInfo.walletType,
    };

    try {
      const first = await fetch("/api/paylabs/discovery-runs/inline", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      // ── Handle 402: payment required ──
      if (first.status === 402) {
        const paymentRequired = first.headers.get("PAYMENT-REQUIRED");
        if (!paymentRequired) {
          setError("Payment challenge missing.");
          setStatus("error");
          return;
        }

        // Decode challenge
        let challenge: Record<string, unknown>;
        try {
          challenge = JSON.parse(atob(paymentRequired));
        } catch {
          setError("Invalid payment challenge.");
          setStatus("error");
          return;
        }

        // Sign with wallet
        setWalletState("approving");
        let paymentSignature: string;
        try {
          paymentSignature = await signWithEoa({
            challenge,
            walletAddress: walletInfo.address,
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Signing failed.";
          setError(msg);
          setWalletState("ready_to_approve");
          setStatus("error");
          return;
        }

        // Retry with payment signature
        const paid = await fetch("/api/paylabs/discovery-runs/inline", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "PAYMENT-SIGNATURE": paymentSignature,
          },
          body: JSON.stringify(body),
        });

        const paidData = await paid.json().catch(() => ({}));
        if (!paid.ok) {
          setError((paidData as Record<string, string>)?.error || "Payment failed.");
          setWalletState("failed");
          setStatus("error");
          return;
        }

        setWalletState("paid");
        setResult(toSafeRunResult(paidData as Record<string, unknown>));
        setStatus("done");
        return;
      }

      // ── Handle non-402 responses ──
      const data = await first.json().catch(() => ({}));
      if (!first.ok) {
        setError((data as Record<string, string>)?.error || "Run failed.");
        setStatus("error");
        return;
      }

      setResult(toSafeRunResult(data as Record<string, unknown>));
      setStatus("done");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error.");
      setStatus("error");
    }
  }, [prompt, tier, budget, walletInfo]);

  const resetChat = useCallback(() => {
    setPrompt("");
    setResult(null);
    setError(null);
    setStatus("idle");
  }, []);

  return (
    <div className="pl-app">
      <SidebarPanel
        analytics={analytics}
        explorerRuns={explorerRuns}
        feedItems={feedItems}
      />

      <main className="pl-main">
        <div className="pl-topbar">
          <div />
          <button
            className="pl-wallet-btn"
            onClick={() => setWalletOpen(true)}
          >
            {walletInfo ? short(walletInfo.address) : "Connect wallet"}
          </button>
        </div>

        <section className="pl-hero">
          <h1>Ask PayLabs</h1>
          <p>Routes, receipts, and x402 payments.</p>

          <div className="pl-search">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask for a route, receipt, or source-backed payment…"
              rows={2}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitChat();
                }
              }}
            />
            <div className="pl-search-actions">
              <select
                value={tier}
                onChange={(e) => setTier(e.target.value as "easy" | "normal" | "advanced")}
              >
                <option value="easy">Easy</option>
                <option value="normal">Normal</option>
                <option value="advanced">Advanced</option>
              </select>
              <div className="pl-budget">
                <span>Budget</span>
                <input
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  type="number"
                  step="0.001"
                  min="0"
                />
                <small>USDC</small>
              </div>
              <button
                className="pl-run-btn"
                onClick={submitChat}
                disabled={status === "running" || !prompt.trim()}
              >
                {status === "running" ? "Running…" : "Run"}
              </button>
            </div>
          </div>

          <div className="pl-chips">
            <button onClick={() => setPrompt("Find the cheapest route under my budget")}>
              Cheapest route
            </button>
            <button onClick={() => setPrompt("Show my recent receipts")}>
              Recent receipts
            </button>
            <button onClick={() => setPrompt("Explain my last payment")}>
              Explain payment
            </button>
            <button onClick={() => setPrompt("Open global explorer")}>
              Global explorer
            </button>
          </div>
        </section>

        {/* Conversation area */}
        {(result || error || status === "running") && (
          <section className="pl-conversation">
            {/* User bubble */}
            {prompt && (
              <div className="pl-user-bubble">{prompt}</div>
            )}

            {/* Response card */}
            <div className="pl-answer-card">
              <div className="pl-answer-head">
                <b>PayLabs</b>
                <span>
                  {status === "running"
                    ? "Running…"
                    : status === "error"
                    ? "Error"
                    : "Done"}
                </span>
              </div>

              {status === "running" && (
                <div className="pl-run-card">
                  <div>
                    <span>Tier</span>
                    <b>{tier}</b>
                  </div>
                  <div>
                    <span>Budget</span>
                    <b>{budget} USDC</b>
                  </div>
                  <div>
                    <span>Planned</span>
                    <b>{planned} USDC</b>
                  </div>
                  <div className="pl-run-status">Processing…</div>
                </div>
              )}

              {error && (
                <div className="pl-error-msg">{error}</div>
              )}

              {result && <ResultCard result={result} onReset={resetChat} />}
            </div>
          </section>
        )}
      </main>

      <WalletConnectModal
        open={walletOpen}
        onClose={() => setWalletOpen(false)}
        walletState={walletState}
        walletInfo={walletInfo}
        budget={budget}
        plannedCost={planned}
        error={walletError}
        onConnectEoa={connectEoa}
        onApprove={() => {
          setWalletOpen(false);
          submitChat();
        }}
      />
    </div>
  );
}

// ─── Result Card ────────────────────────────────────────────

function ResultCard({ result, onReset }: { result: SafeRunResult; onReset: () => void }) {
  return (
    <div className="pl-result-card">
      <div className="pl-result-row">
        <span>Status</span>
        <b>{result.ok ? "Run completed" : "Run failed"}</b>
      </div>
      <div className="pl-result-row">
        <span>Tier</span>
        <b style={{ textTransform: "capitalize" }}>{result.tier || "—"}</b>
      </div>
      <div className="pl-result-row">
        <span>Entry</span>
        <b>{result.entryPaymentStatus || "—"}</b>
      </div>
      <div className="pl-result-row">
        <span>Paid edges</span>
        <b>{result.paidEdges}/{result.totalEdges}</b>
      </div>
      <div className="pl-result-row">
        <span>Planned</span>
        <b>{result.plannedCostUsdc != null ? `${result.plannedCostUsdc} USDC` : "—"}</b>
      </div>
      <div className="pl-result-row">
        <span>Receipt</span>
        <b>{result.receiptReady ? "Ready" : "Pending"}</b>
      </div>
      {result.runId && (
        <div className="pl-result-links">
          <a href={`/dashboard?run=${result.runId}`}>View details</a>
          <button onClick={onReset} className="pl-new-run">New run</button>
        </div>
      )}
    </div>
  );
}
