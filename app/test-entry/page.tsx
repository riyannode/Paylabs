"use client";
import { useState, useEffect, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
const ARC_CHAIN_ID = 5042002;
const ARC_NETWORK = `eip155:${ARC_CHAIN_ID}`;
const EXPLORER_TX = "https://arc-testnet.blockscout.com/tx";

// ─── x402 Authorization Types (EIP-712) ───────────────────────
const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

// ─── Helpers ──────────────────────────────────────────────────

function generatePrivateKey(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as `0x${string}`;
}

function createNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as `0x${string}`;
}

// Keccak256 of "ECDSARecover(address,bytes32,bytes)" → derive address from private key
// Using SubtleCrypto is too complex; we'll use viem dynamically.
async function getAddressFromKey(pk: `0x${string}`): Promise<string> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(pk);
  return account.address;
}

async function signEIP712(
  pk: `0x${string}`,
  domain: Record<string, unknown>,
  types: Record<string, Array<{ name: string; type: string }>>,
  primaryType: string,
  message: Record<string, unknown>
): Promise<string> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(pk);
  // viem's signTypedData handles EIP-712
  const signature = await account.signTypedData({
    domain: domain as any,
    types,
    primaryType: primaryType as any,
    message: message as any,
  });
  return signature;
}

// ─── Inline API base (auto-detect) ────────────────────────────
function getApiBase(): string {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return "";
}

// ─── Page Component ──────────────────────────────────────────

type Tier = "easy" | "normal" | "advanced";
type RunStatus =
  | "idle"
  | "waiting_for_funding"
  | "calling_api"
  | "handling_402"
  | "signing"
  | "retrying"
  | "done"
  | "error";

interface RunResult {
  tier: Tier;
  status: string;
  runId?: string;
  entryTxHash?: string;
  entryExplorerUrl?: string;
  edgeCount?: number;
  paidEdgeCount?: number;
  dbStatus?: string;
  error?: string;
  rawResponse?: unknown;
}

export default function TestEntryPage() {
  const [privateKey, setPrivateKey] = useState<`0x${string}` | null>(null);
  const [walletAddress, setWalletAddress] = useState<string>("");
  const [selectedTier, setSelectedTier] = useState<Tier>("easy");
  const [goal, setGoal] = useState("find RSSHub sources about AI agents");
  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [results, setResults] = useState<RunResult[]>([]);
  const [apiBase, setApiBase] = useState("");

  // Generate wallet on mount
  useEffect(() => {
    const pk = generatePrivateKey();
    setPrivateKey(pk);
    setApiBase(getApiBase());
    getAddressFromKey(pk).then(setWalletAddress);
  }, []);

  const runTierTest = useCallback(
    async (tier: Tier) => {
      if (!privateKey || !walletAddress) return;

      setRunStatus("calling_api");
      setStatusMsg(`Calling inline discovery API (${tier})...`);

      const body = {
        goal,
        user_wallet: walletAddress.toLowerCase(),
        route_tier: tier,
        budget_usdc: 0.01,
      };

      // ── Step 1: Initial request (expect 402) ──
      let resp: Response;
      try {
        resp = await fetch(`${apiBase}/api/paylabs/discovery-runs/inline`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (e: any) {
        setRunStatus("error");
        setStatusMsg(`API unreachable: ${e.message}`);
        setResults((prev) => [
          ...prev,
          { tier, status: "error", error: `API unreachable: ${e.message}` },
        ]);
        return;
      }

      // If not 402, check what happened
      if (resp.status !== 402) {
        const data = await resp.json().catch(() => null);
        if (data?.status === "completed" || data?.ok) {
          // Entry gate not deployed — got direct orchestration result
          setRunStatus("error");
          setStatusMsg(
            `Entry gate NOT deployed (got HTTP ${resp.status}, not 402). Deploy PR #24 first.`
          );
          setResults((prev) => [
            ...prev,
            {
              tier,
              status: "no_entry_gate",
              rawResponse: data,
              error: `Entry payment gate not deployed — API returned ${resp.status} instead of 402`,
            },
          ]);
          return;
        }
        setRunStatus("error");
        setStatusMsg(`Unexpected HTTP ${resp.status}`);
        setResults((prev) => [
          ...prev,
          {
            tier,
            status: "error",
            rawResponse: data,
            error: `Expected 402, got HTTP ${resp.status}`,
          },
        ]);
        return;
      }

      // ── Step 2: Parse 402 challenge ──
      setRunStatus("handling_402");
      setStatusMsg("Got 402 challenge, parsing PAYMENT-REQUIRED header...");

      const paymentRequiredHeader =
        resp.headers.get("payment-required") ||
        resp.headers.get("PAYMENT-REQUIRED");

      if (!paymentRequiredHeader) {
        setRunStatus("error");
        setStatusMsg("402 but no PAYMENT-REQUIRED header");
        setResults((prev) => [
          ...prev,
          {
            tier,
            status: "error",
            error: "402 but no PAYMENT-REQUIRED header",
          },
        ]);
        return;
      }

      const challengeBody = await resp.json().catch(() => ({}));
      const runId = challengeBody?.discovery_run_id;

      let challenge: any;
      try {
        const decoded = atob(paymentRequiredHeader);
        challenge = JSON.parse(decoded);
      } catch (e: any) {
        setRunStatus("error");
        setStatusMsg(`Invalid PAYMENT-REQUIRED header: ${e.message}`);
        setResults((prev) => [
          ...prev,
          {
            tier,
            status: "error",
            error: `Invalid PAYMENT-REQUIRED header: ${e.message}`,
          },
        ]);
        return;
      }

      const accepts = challenge?.accepts || [];
      const gatewayReq = accepts.find(
        (r: any) =>
          r?.extra?.name === "GatewayWalletBatched" ||
          (r?.scheme === "exact" && r?.extra?.verifyingContract)
      );

      if (!gatewayReq) {
        setRunStatus("error");
        setStatusMsg("No Gateway batching option in 402 challenge");
        setResults((prev) => [
          ...prev,
          {
            tier,
            status: "error",
            error: "No GatewayWalletBatched option in 402 challenge",
          },
        ]);
        return;
      }

      setStatusMsg(
        `Challenge parsed. Amount: ${gatewayReq.amount} atomic, payTo: ${gatewayReq.payTo.slice(0, 10)}...`
      );

      // ── Step 3: Sign x402 payment ──
      setRunStatus("signing");
      setStatusMsg("Signing EIP-712 TransferWithAuthorization...");

      const verifyingContract =
        gatewayReq.extra?.verifyingContract || GATEWAY_WALLET;
      const chainId = parseInt(
        (gatewayReq.network || ARC_NETWORK).split(":")[1]
      );
      const now = Math.floor(Date.now() / 1000);
      const maxTimeout = Math.max(
        gatewayReq.maxTimeoutSeconds || 604900,
        604900
      );
      const nonce = createNonce();

      const domain = {
        name: "GatewayWalletBatched",
        version: "1",
        chainId,
        verifyingContract: verifyingContract as `0x${string}`,
      };

      const authorization = {
        from: walletAddress.toLowerCase() as `0x${string}`,
        to: gatewayReq.payTo.toLowerCase() as `0x${string}`,
        value: gatewayReq.amount,
        validAfter: (now - 600).toString(),
        validBefore: (now + maxTimeout).toString(),
        nonce,
      };

      let signature: string;
      try {
        signature = await signEIP712(
          privateKey,
          domain,
          AUTH_TYPES,
          "TransferWithAuthorization",
          {
            from: authorization.from,
            to: authorization.to,
            value: BigInt(authorization.value),
            validAfter: BigInt(authorization.validAfter),
            validBefore: BigInt(authorization.validBefore),
            nonce: authorization.nonce,
          } as any
        );
        setStatusMsg(`Signed! Sig: ${signature.slice(0, 18)}...`);
      } catch (e: any) {
        setRunStatus("error");
        setStatusMsg(`Signing failed: ${e.message}`);
        setResults((prev) => [
          ...prev,
          {
            tier,
            status: "error",
            runId,
            error: `EIP-712 signing failed: ${e.message}`,
          },
        ]);
        return;
      }

      // Build payment payload
      const paymentPayload = {
        x402Version: challenge.x402Version || 2,
        payload: {
          authorization,
          signature,
        },
        resource: challenge.resource,
        accepted: gatewayReq,
      };

      const paymentSignatureBase64 = btoa(JSON.stringify(paymentPayload));

      // ── Step 4: Retry with payment ──
      setRunStatus("retrying");
      setStatusMsg("Retrying with PAYMENT-SIGNATURE header...");

      let retryResp: Response;
      try {
        retryResp = await fetch(`${apiBase}/api/paylabs/discovery-runs/inline`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "PAYMENT-SIGNATURE": paymentSignatureBase64,
          },
          body: JSON.stringify(body),
        });
      } catch (e: any) {
        setRunStatus("error");
        setStatusMsg(`Retry failed: ${e.message}`);
        setResults((prev) => [
          ...prev,
          {
            tier,
            status: "error",
            runId,
            error: `Retry request failed: ${e.message}`,
          },
        ]);
        return;
      }

      const retryData = await retryResp.json().catch(() => ({}));

      setRunStatus("done");

      const result: RunResult = {
        tier,
        status: retryData?.ok ? "success" : "failed",
        runId: retryData?.discovery_run_id || runId,
        entryTxHash: retryData?.entry_payment?.tx_hash,
        entryExplorerUrl: retryData?.entry_payment?.explorer_url,
        edgeCount: retryData?.payment_graph?.length || 0,
        paidEdgeCount:
          retryData?.payment_graph?.filter(
            (e: any) => e.status === "paid"
          )?.length || 0,
        dbStatus: retryData?.status,
        error: retryData?.error,
        rawResponse: retryData,
      };

      setStatusMsg(
        result.status === "success"
          ? `✅ ${tier} completed! Run ${result.runId?.slice(0, 8)}... | ${result.paidEdgeCount}/${result.edgeCount} edges paid | DB: ${result.dbStatus}`
          : `❌ ${tier} failed: ${result.error}`
      );

      setResults((prev) => [...prev, result]);
    },
    [privateKey, walletAddress, goal, apiBase]
  );

  const runAllTiers = useCallback(async () => {
    setResults([]);
    for (const tier of ["easy", "normal", "advanced"] as Tier[]) {
      await runTierTest(tier);
    }
  }, [runTierTest]);

  // ─── Negative test: payer mismatch ─────────────────────────
  const testPayerMismatch = useCallback(async () => {
    if (!privateKey) return;

    setRunStatus("calling_api");
    setStatusMsg("Testing payer mismatch (different wallet in body vs signer)...");

    const fakeWallet = "0xDEAD000000000000000000000000000000000001";
    const body = {
      goal,
      user_wallet: fakeWallet,
      route_tier: "easy",
      budget_usdc: 0.01,
    };

    // First call — get 402
    let resp: Response;
    try {
      resp = await fetch(`${apiBase}/api/paylabs/discovery-runs/inline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      setRunStatus("error");
      setStatusMsg(`API unreachable: ${e.message}`);
      return;
    }

    if (resp.status !== 402) {
      setRunStatus("error");
      setStatusMsg(
        `Entry gate not deployed (HTTP ${resp.status}), cannot test payer mismatch`
      );
      return;
    }

    // Parse challenge
    const paymentRequiredHeader =
      resp.headers.get("payment-required") ||
      resp.headers.get("PAYMENT-REQUIRED");
    if (!paymentRequiredHeader) {
      setRunStatus("error");
      setStatusMsg("No PAYMENT-REQUIRED header");
      return;
    }

    const challengeBody2 = await resp.json().catch(() => ({}));
    const runId = challengeBody2?.discovery_run_id;

    let challenge: any;
    try {
      challenge = JSON.parse(atob(paymentRequiredHeader));
    } catch {
      setRunStatus("error");
      setStatusMsg("Invalid challenge");
      return;
    }

    const gatewayReq = challenge?.accepts?.find(
      (r: any) => r?.extra?.name === "GatewayWalletBatched"
    );
    if (!gatewayReq) {
      setRunStatus("error");
      setStatusMsg("No gateway option");
      return;
    }

    // Sign with REAL wallet (different from fakeWallet in body)
    const verifyingContract =
      gatewayReq.extra?.verifyingContract || GATEWAY_WALLET;
    const chainId = parseInt(
      (gatewayReq.network || ARC_NETWORK).split(":")[1]
    );
    const now = Math.floor(Date.now() / 1000);
    const maxTimeout = Math.max(gatewayReq.maxTimeoutSeconds || 604900, 604900);
    const nonce = createNonce();

    const domain = {
      name: "GatewayWalletBatched",
      version: "1",
      chainId,
      verifyingContract: verifyingContract as `0x${string}`,
    };

    const authorization = {
      from: walletAddress.toLowerCase() as `0x${string}`, // real wallet
      to: gatewayReq.payTo.toLowerCase() as `0x${string}`,
      value: gatewayReq.amount,
      validAfter: (now - 600).toString(),
      validBefore: (now + maxTimeout).toString(),
      nonce,
    };

    let signature: string;
    try {
      signature = await signEIP712(
        privateKey!,
        domain,
        AUTH_TYPES,
        "TransferWithAuthorization",
        {
          from: authorization.from,
          to: authorization.to,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce,
        } as any
      );
    } catch (e: any) {
      setRunStatus("error");
      setStatusMsg(`Signing failed: ${e.message}`);
      return;
    }

    const paymentPayload = {
      x402Version: challenge.x402Version || 2,
      payload: { authorization, signature },
      resource: challenge.resource,
      accepted: gatewayReq,
    };

    // Retry with fake wallet in body but real wallet's signature
    let retryResp: Response;
    try {
      retryResp = await fetch(`${apiBase}/api/paylabs/discovery-runs/inline`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-SIGNATURE": btoa(JSON.stringify(paymentPayload)),
        },
        body: JSON.stringify(body), // fakeWallet in body
      });
    } catch (e: any) {
      setRunStatus("error");
      setStatusMsg(`Retry failed: ${e.message}`);
      return;
    }

    const retryData = await retryResp.json().catch(() => ({}));

    setRunStatus("done");

    if (
      retryResp.status === 403 ||
      retryData?.error?.includes("payer") ||
      retryData?.error?.includes("mismatch")
    ) {
      setStatusMsg(
        `✅ Payer mismatch correctly rejected (HTTP ${retryResp.status}). Run: ${runId?.slice(0, 8)}...`
      );
      setResults((prev) => [
        ...prev,
        {
          tier: "easy" as Tier,
          status: "correctly_rejected",
          runId,
          error: retryData?.error,
        },
      ]);
    } else {
      setStatusMsg(
        `⚠️ Payer mismatch NOT rejected! HTTP ${retryResp.status}. This may be a security issue.`
      );
      setResults((prev) => [
        ...prev,
        {
          tier: "easy" as Tier,
          status: "security_issue",
          runId,
          rawResponse: retryData,
          error: `Payer mismatch should have been rejected but got HTTP ${retryResp.status}`,
        },
      ]);
    }
  }, [privateKey, walletAddress, goal, apiBase]);

  // ─── Negative test: bad signature ──────────────────────────
  const testBadSignature = useCallback(async () => {
    if (!privateKey) return;

    setRunStatus("calling_api");
    setStatusMsg("Testing bad/invalid payment signature...");

    const body = {
      goal,
      user_wallet: walletAddress.toLowerCase(),
      route_tier: "easy",
      budget_usdc: 0.01,
    };

    // First call — get 402
    let resp: Response;
    try {
      resp = await fetch(`${apiBase}/api/paylabs/discovery-runs/inline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      setRunStatus("error");
      setStatusMsg(`API unreachable: ${e.message}`);
      return;
    }

    if (resp.status !== 402) {
      setRunStatus("error");
      setStatusMsg(
        `Entry gate not deployed (HTTP ${resp.status}), cannot test bad signature`
      );
      return;
    }

    // Send garbage as PAYMENT-SIGNATURE
    const badSignature = btoa(JSON.stringify({ garbage: true, not: "valid" }));

    let retryResp: Response;
    try {
      retryResp = await fetch(`${apiBase}/api/paylabs/discovery-runs/inline`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-SIGNATURE": badSignature,
        },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      setRunStatus("error");
      setStatusMsg(`Retry failed: ${e.message}`);
      return;
    }

    const retryData = await retryResp.json().catch(() => ({}));
    setRunStatus("done");

    if (retryResp.status === 402 || !retryData?.ok) {
      setStatusMsg(
        `✅ Bad signature correctly rejected (HTTP ${retryResp.status}). Fail-closed confirmed.`
      );
      setResults((prev) => [
        ...prev,
        {
          tier: "easy" as Tier,
          status: "correctly_rejected",
          error: retryData?.error,
        },
      ]);
    } else {
      setStatusMsg(
        `⚠️ Bad signature NOT rejected! HTTP ${retryResp.status}. Security issue!`
      );
      setResults((prev) => [
        ...prev,
        {
          tier: "easy" as Tier,
          status: "security_issue",
          rawResponse: retryData,
          error: `Bad signature should have been rejected but got HTTP ${retryResp.status}`,
        },
      ]);
    }
  }, [privateKey, walletAddress, goal, apiBase]);

  // ─── Render ─────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>
        Customer x402 Entry Payment — Live Test
      </h1>
      <p style={{ color: "#888", fontSize: 14, marginBottom: 24 }}>
        Tests the full customer entry payment flow against the deployed
        preview. No scripts — real browser wallet signing.
      </p>

      {/* Wallet Info */}
      <div
        style={{
          background: "#1a1a2e",
          borderRadius: 12,
          padding: 20,
          marginBottom: 24,
        }}
      >
        <div style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>
          Fresh Customer Wallet (generated in browser)
        </div>
        <div
          style={{
            fontFamily: "monospace",
            fontSize: 14,
            wordBreak: "break-all",
            color: "#4ade80",
          }}
        >
          {walletAddress || "generating..."}
        </div>
        <div
          style={{
            fontSize: 12,
            color: "#888",
            marginTop: 8,
            padding: "8px 12px",
            background: "#0d0d1a",
            borderRadius: 8,
          }}
        >
          ⚠️ Fund this address with USDC on <strong>Arc Testnet</strong> before
          running paid tests.
          <br />
          Private key is ephemeral (generated in-memory, never stored).
        </div>
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <select
          value={selectedTier}
          onChange={(e) => setSelectedTier(e.target.value as Tier)}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            background: "#1a1a2e",
            color: "#fff",
            border: "1px solid #333",
          }}
        >
          <option value="easy">Easy (0.000007 USDC, 5 edges)</option>
          <option value="normal">Normal (0.000013 USDC, 11 edges)</option>
          <option value="advanced">Advanced (0.000015 USDC, 13 edges)</option>
        </select>

        <button
          onClick={() => runTierTest(selectedTier)}
          disabled={
            !walletAddress ||
            runStatus === "calling_api" ||
            runStatus === "signing" ||
            runStatus === "retrying"
          }
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            background: "#3b82f6",
            color: "#fff",
            border: "none",
            fontWeight: 600,
            cursor: "pointer",
            opacity:
              !walletAddress ||
              runStatus === "calling_api" ||
              runStatus === "signing" ||
              runStatus === "retrying"
                ? 0.5
                : 1,
          }}
        >
          Run {selectedTier}
        </button>

        <button
          onClick={runAllTiers}
          disabled={
            !walletAddress ||
            runStatus === "calling_api" ||
            runStatus === "signing" ||
            runStatus === "retrying"
          }
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            background: "#10b981",
            color: "#fff",
            border: "none",
            fontWeight: 600,
            cursor: "pointer",
            opacity:
              !walletAddress ||
              runStatus === "calling_api" ||
              runStatus === "signing" ||
              runStatus === "retrying"
                ? 0.5
                : 1,
          }}
        >
          Run All Tiers
        </button>
      </div>

      {/* Negative tests */}
      <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        <button
          onClick={testPayerMismatch}
          disabled={
            !walletAddress ||
            runStatus === "calling_api" ||
            runStatus === "signing" ||
            runStatus === "retrying"
          }
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            background: "#ef4444",
            color: "#fff",
            border: "none",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Test Payer Mismatch
        </button>

        <button
          onClick={testBadSignature}
          disabled={
            !walletAddress ||
            runStatus === "calling_api" ||
            runStatus === "signing" ||
            runStatus === "retrying"
          }
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            background: "#f59e0b",
            color: "#fff",
            border: "none",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Test Bad Signature
        </button>
      </div>

      {/* Status */}
      {statusMsg && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: 8,
            background:
              runStatus === "error"
                ? "#2d0a0a"
                : runStatus === "done"
                  ? "#0a2d0a"
                  : "#1a1a2e",
            border: `1px solid ${runStatus === "error" ? "#ef4444" : runStatus === "done" ? "#10b981" : "#333"}`,
            marginBottom: 24,
            fontSize: 14,
            fontFamily: "monospace",
          }}
        >
          {statusMsg}
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>
            Results ({results.length})
          </h2>
          {results.map((r, i) => (
            <div
              key={i}
              style={{
                background: "#1a1a2e",
                borderRadius: 12,
                padding: 16,
                marginBottom: 12,
                border: `1px solid ${r.status === "success" ? "#10b981" : r.status === "correctly_rejected" ? "#3b82f6" : "#ef4444"}`,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 8,
                }}
              >
                <span style={{ fontWeight: 700, fontSize: 16 }}>{r.tier}</span>
                <span
                  style={{
                    color:
                      r.status === "success"
                        ? "#4ade80"
                        : r.status === "correctly_rejected"
                          ? "#60a5fa"
                          : "#f87171",
                    fontWeight: 600,
                  }}
                >
                  {r.status}
                </span>
              </div>

              {r.runId && (
                <div style={{ fontSize: 12, color: "#888" }}>
                  Run ID:{" "}
                  <span style={{ fontFamily: "monospace" }}>{r.runId}</span>
                </div>
              )}
              {r.entryTxHash && (
                <div style={{ fontSize: 12, color: "#888" }}>
                  Tx:{" "}
                  <a
                    href={`${EXPLORER_TX}/${r.entryTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "#60a5fa" }}
                  >
                    {r.entryTxHash.slice(0, 18)}...
                  </a>
                </div>
              )}
              {r.edgeCount !== undefined && (
                <div style={{ fontSize: 12, color: "#888" }}>
                  Edges: {r.paidEdgeCount}/{r.edgeCount} paid
                </div>
              )}
              {r.dbStatus && (
                <div style={{ fontSize: 12, color: "#888" }}>
                  DB Status: {r.dbStatus}
                </div>
              )}
              {r.error && (
                <div
                  style={{
                    fontSize: 12,
                    color: "#f87171",
                    marginTop: 4,
                    fontFamily: "monospace",
                  }}
                >
                  {r.error}
                </div>
              )}

              {/* Expandable raw response */}
              <details style={{ marginTop: 8 }}>
                <summary
                  style={{
                    fontSize: 11,
                    color: "#666",
                    cursor: "pointer",
                  }}
                >
                  Raw response
                </summary>
                <pre
                  style={{
                    fontSize: 10,
                    color: "#888",
                    overflow: "auto",
                    maxHeight: 300,
                    marginTop: 4,
                    padding: 8,
                    background: "#0d0d1a",
                    borderRadius: 4,
                  }}
                >
                  {JSON.stringify(r.rawResponse, null, 2)}
                </pre>
              </details>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
