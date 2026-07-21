"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PayLabsWalletBalance } from "./wallet-types";
import type { UcwChallengeKind, UcwChallengeExecutionResult } from "./useCreatorUcwWallet";

type WithdrawalStatus =
  | "prepared"
  | "burn_signature_pending"
  | "burn_signed"
  | "gateway_submitted"
  | "attestation_received"
  | "mint_submission_pending"
  | "mint_approval_pending"
  | "mint_submitted"
  | "finalized"
  | "failed"
  | "expired"
  | "reconciliation_required";

type UiPhase =
  | "idle"
  | "preparing"
  | "burn_approval_executing"
  | "burn_signature_submitting"
  | "mint_approval_executing"
  | "mint_resolving"
  | "resuming"
  | "approval_cancelled"
  | "reconnect_required";

type ContinueMode = "fresh" | "resume";

type WithdrawalResponse = {
  ok?: boolean;
  withdrawalId?: string;
  status?: WithdrawalStatus;
  signChallengeId?: string | null;
  mintChallengeId?: string | null;
  circleTransactionId?: string | null;
  txHash?: string | null;
  explorerUrl?: string | null;
  error?: string;
};

type StoredUcwWithdrawal = {
  withdrawalId: string | null;
  amount: string;
  idempotencyKey: string;
  backendStatus: string | null;
  signChallengeId: string | null;
  mintChallengeId: string | null;
  updatedAt: number;
};

type CreatorWalletGatewayPanelProps = {
  walletId: string;
  walletAddress: string;
  balance: PayLabsWalletBalance | null;
  needsReconnectToSign: boolean;
  onReconnect: () => void;
  onRefreshBalance: () => Promise<void>;
  onDisconnect: () => Promise<void> | void;
  executeUcwChallenge: (
    challengeId: string,
    kind: UcwChallengeKind,
  ) => Promise<UcwChallengeExecutionResult>;
};

function shortAddr(addr?: string | null) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function asDecimal(value?: string | null): number {
  const n = Number(value ?? "0");
  return Number.isFinite(n) ? n : 0;
}

function formatUsdc(value?: string | null) {
  if (value == null) return "Checking…";
  return `${asDecimal(value).toFixed(6)} USDC`;
}

function storageKey(walletAddress: string) {
  return `paylabs:ucw-withdrawal:${walletAddress.toLowerCase()}`;
}

type FinalTerminalStatus = "finalized" | "failed" | "expired";

function isFinalTerminal(status?: string | null): status is FinalTerminalStatus {
  return status === "finalized" || status === "failed" || status === "expired";
}

function stopsAutomaticProgress(status?: string | null) {
  return isFinalTerminal(status) || status === "reconciliation_required";
}

function backendStatusLabel(status: string | null, phase: UiPhase) {
  if (phase === "approval_cancelled") {
    return "Approval was cancelled. Resume the existing withdrawal to continue.";
  }
  if (phase === "reconnect_required") {
    return "Reconnect Creator Wallet to resume this withdrawal.";
  }
  switch (status) {
    case "prepared":
      return "Preparing withdrawal…";
    case "burn_signature_pending":
      return "Waiting for withdrawal approval…";
    case "burn_signed":
      return "Withdrawal approved…";
    case "gateway_submitted":
      return "Submitted to Gateway…";
    case "attestation_received":
      return "Gateway attestation received…";
    case "mint_submission_pending":
      return "Preparing withdrawal transaction…";
    case "mint_approval_pending":
      return "Waiting for transaction approval…";
    case "mint_submitted":
      return "Finalizing withdrawal…";
    case "finalized":
      return "Withdrawal complete.";
    case "failed":
      return "Withdrawal failed.";
    case "expired":
      return "Withdrawal expired.";
    case "reconciliation_required":
      return "Withdrawal requires reconciliation. Retry recovery before creating another withdrawal.";
    default:
      if (phase === "preparing") return "Preparing withdrawal…";
      if (phase === "burn_approval_executing") return "Waiting for withdrawal approval…";
      if (phase === "burn_signature_submitting") return "Submitting withdrawal approval…";
      if (phase === "mint_approval_executing") return "Waiting for transaction approval…";
      if (phase === "mint_resolving") return "Finalizing withdrawal…";
      if (phase === "resuming") return "Resuming withdrawal…";
      return "";
  }
}

function statusColor(status: string | null, phase: UiPhase) {
  if (phase === "approval_cancelled" || phase === "reconnect_required") return "var(--warn, #f59e0b)";
  if (status === "finalized") return "var(--success, #22c55e)";
  if (status === "failed" || status === "expired" || status === "reconciliation_required") return "var(--error, #ef4444)";
  return "var(--info, #3b82f6)";
}

async function copyToClipboard(value: string) {
  try {
    await navigator.clipboard?.writeText(value);
    return true;
  } catch {
    try {
      const textArea = document.createElement("textarea");
      textArea.value = value;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(textArea);
      return ok;
    } catch {
      return false;
    }
  }
}

function safeStoredWithdrawal(value: string | null): StoredUcwWithdrawal | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredUcwWithdrawal>;
    if (!parsed.idempotencyKey || typeof parsed.idempotencyKey !== "string") return null;
    if (!parsed.amount || typeof parsed.amount !== "string") return null;
    return {
      withdrawalId: typeof parsed.withdrawalId === "string" ? parsed.withdrawalId : null,
      amount: parsed.amount,
      idempotencyKey: parsed.idempotencyKey,
      backendStatus: typeof parsed.backendStatus === "string" ? parsed.backendStatus : null,
      signChallengeId: typeof parsed.signChallengeId === "string" ? parsed.signChallengeId : null,
      mintChallengeId: typeof parsed.mintChallengeId === "string" ? parsed.mintChallengeId : null,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="pl-info-row-v3">
      <span className="pl-row-icon-v3">●</span>
      <span className="pl-row-label-v3">{label}</span>
      <b>{value}</b>
    </div>
  );
}

export default function CreatorWalletGatewayPanel({
  walletId,
  walletAddress,
  balance,
  needsReconnectToSign,
  onReconnect,
  onRefreshBalance,
  onDisconnect,
  executeUcwChallenge,
}: CreatorWalletGatewayPanelProps) {
  const [copied, setCopied] = useState(false);
  const [amount, setAmount] = useState("");
  const [storedAttempt, setStoredAttempt] = useState<StoredUcwWithdrawal | null>(null);
  const [backendStatus, setBackendStatus] = useState<WithdrawalStatus | null>(null);
  const [uiPhase, setUiPhase] = useState<UiPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [circleTransactionId, setCircleTransactionId] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [explorerUrl, setExplorerUrl] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollInFlightRef = useRef(false);
  const submitInFlightRef = useRef(false);
  const storedAttemptRef = useRef<StoredUcwWithdrawal | null>(null);
  const needsReconnectRef = useRef(needsReconnectToSign);

  const key = useMemo(() => storageKey(walletAddress), [walletAddress]);
  const gatewayBalance = asDecimal(balance?.gatewayUsdc ?? "0");
  const statusMessage = error || backendStatusLabel(backendStatus, uiPhase);
  const amountLocked = !!storedAttempt && !isFinalTerminal(backendStatus);
  const submitBusy = submitInFlightRef.current || ["preparing", "burn_approval_executing", "burn_signature_submitting", "mint_approval_executing", "mint_resolving", "resuming"].includes(uiPhase);
  const isReconciliation = backendStatus === "reconciliation_required";
  const terminalBlocked = isReconciliation || backendStatus === "finalized";
  const resumeAction = !!storedAttempt && !isFinalTerminal(backendStatus);
  const resumeLabel = isReconciliation
    ? submitBusy
      ? "Recovering…"
      : "Retry recovery"
    : submitBusy
      ? "Resuming…"
      : "Resume approval";

  const persistAttempt = useCallback((next: StoredUcwWithdrawal | null) => {
    storedAttemptRef.current = next;
    setStoredAttempt(next);
    if (next) {
      sessionStorage.setItem(key, JSON.stringify({ ...next, updatedAt: Date.now() }));
    } else {
      sessionStorage.removeItem(key);
    }
  }, [key]);

  const patchAttempt = useCallback((patch: Partial<StoredUcwWithdrawal>) => {
    const current = storedAttemptRef.current;
    if (!current) return;
    persistAttempt({ ...current, ...patch, updatedAt: Date.now() });
  }, [persistAttempt]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    pollInFlightRef.current = false;
  }, []);

  const applyBackendResponse = useCallback(async (data: WithdrawalResponse) => {
    const status = data.status ?? null;
    if (status) setBackendStatus(status);
    if (typeof data.circleTransactionId === "string") setCircleTransactionId(data.circleTransactionId);
    if (typeof data.txHash === "string") setTxHash(data.txHash);
    if (typeof data.explorerUrl === "string") setExplorerUrl(data.explorerUrl);

    if (storedAttemptRef.current) {
      patchAttempt({
        withdrawalId: data.withdrawalId ?? storedAttemptRef.current.withdrawalId,
        backendStatus: status ?? storedAttemptRef.current.backendStatus,
        signChallengeId: data.signChallengeId ?? storedAttemptRef.current.signChallengeId,
        mintChallengeId: data.mintChallengeId ?? storedAttemptRef.current.mintChallengeId,
      });
    }

    if (status === "finalized") {
      stopPolling();
      setUiPhase("idle");
      setError(null);
      persistAttempt(null);
      setAmount("");
      await onRefreshBalance();
      return true;
    }

    if (status === "failed" || status === "expired") {
      stopPolling();
      setUiPhase("idle");
      persistAttempt(null);
      return true;
    }

    if (status === "reconciliation_required") {
      stopPolling();
      setUiPhase("idle");
      return true;
    }

    return false;
  }, [onRefreshBalance, patchAttempt, persistAttempt, stopPolling]);

  const getStatus = useCallback(async (withdrawalId: string, useMintRoute: boolean) => {
    const endpoint = useMintRoute
      ? `/api/paylabs/wallet/ucw/withdraw/mint?withdrawalId=${encodeURIComponent(withdrawalId)}`
      : `/api/paylabs/wallet/ucw/withdraw?withdrawalId=${encodeURIComponent(withdrawalId)}`;
    const resp = await fetch(endpoint, { credentials: "include", cache: "no-store" });
    const data = (await resp.json().catch(() => ({}))) as WithdrawalResponse;
    if (!resp.ok || data.ok === false) throw new Error(data.error || "Unable to check withdrawal status");
    return data;
  }, []);

  const startPolling = useCallback((withdrawalId: string, initialStatus?: string | null) => {
    stopPolling();
    const pollOnce = async () => {
      if (pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      try {
        const current = storedAttemptRef.current;
        const status = current?.backendStatus || initialStatus || backendStatus;
        const data = await getStatus(withdrawalId, status === "mint_submitted");
        await applyBackendResponse(data);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Unable to check withdrawal status");
      } finally {
        pollInFlightRef.current = false;
      }
    };
    pollRef.current = setInterval(() => { void pollOnce(); }, 3000);
    void pollOnce();
  }, [applyBackendResponse, backendStatus, getStatus, stopPolling]);

  const postJson = useCallback(async (url: string, body: Record<string, unknown>) => {
    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await resp.json().catch(() => ({}))) as WithdrawalResponse;
    if (!resp.ok || data.ok === false) {
      const err = new Error(data.error || `Request failed (${resp.status})`);
      (err as Error & { status?: number }).status = resp.status;
      throw err;
    }
    return data;
  }, []);

  const executeOrReconnect = useCallback(async (challengeId: string, kind: UcwChallengeKind) => {
    if (needsReconnectRef.current) {
      setUiPhase("reconnect_required");
      throw new Error("Reconnect Creator Wallet to resume this withdrawal.");
    }
    return executeUcwChallenge(challengeId, kind);
  }, [executeUcwChallenge]);

  const recoverSignChallenge = useCallback(async (attempt: StoredUcwWithdrawal) => {
    if (!attempt.withdrawalId) return null;
    const data = await postJson("/api/paylabs/wallet/ucw/withdraw", {
      withdrawalId: attempt.withdrawalId,
      action: "recover-sign-challenge",
    });
    await applyBackendResponse(data);
    return data;
  }, [applyBackendResponse, postJson]);

  const recoverMintChallenge = useCallback(async (withdrawalId: string) => {
    const data = await postJson("/api/paylabs/wallet/ucw/withdraw/mint", {
      withdrawalId,
      action: "recover-challenge",
    });
    await applyBackendResponse(data);
    return data;
  }, [applyBackendResponse, postJson]);

  const resolveMintChallenge = useCallback(async (withdrawalId: string) => {
    const data = await postJson("/api/paylabs/wallet/ucw/withdraw/mint", { withdrawalId });
    await applyBackendResponse(data);
    return data;
  }, [applyBackendResponse, postJson]);

  const continueFlow = useCallback(async (
    source?: StoredUcwWithdrawal | null,
    mode: ContinueMode = "resume",
    depth = 0,
  ) => {
    const attempt = source ?? storedAttemptRef.current;
    if (!attempt?.withdrawalId || depth > 8) return;

    setError(null);
    const statusData = await getStatus(attempt.withdrawalId, attempt.backendStatus === "mint_submitted");
    await applyBackendResponse(statusData);
    const currentStatus = statusData.status ?? attempt.backendStatus;

    const handleStatus = async (data: WithdrawalResponse, status?: WithdrawalStatus | null, nextDepth = depth + 1): Promise<void> => {
      if (!status || isFinalTerminal(status)) return;

      if (status === "reconciliation_required") {
        stopPolling();
        if (mode !== "resume") return;
        setUiPhase("mint_resolving");
        const recovered = await recoverMintChallenge(attempt.withdrawalId!);
        if (!recovered.status || recovered.status === "reconciliation_required") return;
        return handleStatus(recovered, recovered.status, nextDepth + 1);
      }

      if (status === "gateway_submitted" || status === "attestation_received" || status === "mint_submission_pending") {
        setUiPhase("mint_resolving");
        const recovered = await recoverMintChallenge(attempt.withdrawalId!);
        if (!recovered.status || recovered.status === status) return;
        return handleStatus(recovered, recovered.status, nextDepth + 1);
      }

      if (status === "mint_approval_pending") {
        let mintData = data;
        if (mode === "resume") {
          setUiPhase("mint_resolving");
          const resolved = await resolveMintChallenge(attempt.withdrawalId!);
          if (resolved.status && resolved.status !== "mint_approval_pending") {
            return handleStatus(resolved, resolved.status, nextDepth + 1);
          }
          mintData = resolved;
        }

        const latestAttempt = storedAttemptRef.current ?? attempt;
        const mintChallengeId = mintData.mintChallengeId ?? latestAttempt.mintChallengeId;
        if (!mintChallengeId) throw new Error("No mint challenge is available for this withdrawal.");

        setUiPhase("mint_approval_executing");
        try {
          await executeOrReconnect(mintChallengeId, "gateway-mint");
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : "Creator Wallet approval was cancelled or failed.";
          setError(message);
          setUiPhase(message.includes("Reconnect") ? "reconnect_required" : "approval_cancelled");
          return;
        }

        setUiPhase("mint_resolving");
        const minted = await resolveMintChallenge(attempt.withdrawalId!);
        if (minted.withdrawalId && minted.status === "mint_submitted") {
          startPolling(minted.withdrawalId, minted.status);
          return;
        }
        return handleStatus(minted, minted.status, nextDepth + 1);
      }

      if (status === "mint_submitted") {
        startPolling(attempt.withdrawalId!, status);
        return;
      }

      if (!stopsAutomaticProgress(status)) {
        startPolling(attempt.withdrawalId!, status);
      }
    };

    if (currentStatus === "burn_signature_pending") {
      let signData = statusData;
      if (mode === "resume") {
        const recovered = await recoverSignChallenge(attempt);
        if (!recovered) throw new Error("Unable to recover signing challenge for this withdrawal.");
        signData = recovered;
        if (recovered.status !== "burn_signature_pending") {
          return handleStatus(recovered, recovered.status);
        }
      }

      const latestAttempt = storedAttemptRef.current ?? attempt;
      const signChallengeId = signData.signChallengeId ?? latestAttempt.signChallengeId;
      if (!signChallengeId) throw new Error("No signing challenge is available for this withdrawal.");

      setUiPhase("burn_approval_executing");
      let approval: UcwChallengeExecutionResult;
      try {
        approval = await executeOrReconnect(signChallengeId, "burn-signature");
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Creator Wallet approval was cancelled or failed.";
        setError(message);
        setUiPhase(message.includes("Reconnect") ? "reconnect_required" : "approval_cancelled");
        return;
      }

      if (!approval.signature) throw new Error("Circle completed the approval but returned no valid signature.");
      setUiPhase("burn_signature_submitting");
      const signed = await postJson("/api/paylabs/wallet/ucw/withdraw/sign", {
        withdrawalId: attempt.withdrawalId,
        signature: approval.signature,
      });
      await applyBackendResponse(signed);
      return handleStatus(signed, signed.status);
    }

    return handleStatus(statusData, currentStatus as WithdrawalStatus | null);
  }, [applyBackendResponse, executeOrReconnect, getStatus, postJson, recoverMintChallenge, recoverSignChallenge, resolveMintChallenge, startPolling, stopPolling]);

  const handleWithdraw = useCallback(async () => {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setUiPhase("preparing");
    setError(null);
    setTxHash(null);
    setExplorerUrl(null);
    setCircleTransactionId(null);

    try {
      const amountText = amount.trim();
      const amountNumber = Number(amountText);
      if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
        throw new Error("Enter a valid amount");
      }
      if (balance?.gatewayUsdc != null && amountNumber > gatewayBalance) {
        throw new Error("Amount exceeds your available Gateway balance");
      }

      const resumingExistingAttempt = !!storedAttemptRef.current?.withdrawalId;
      const idempotencyKey = storedAttemptRef.current?.idempotencyKey ?? crypto.randomUUID();
      const attempt: StoredUcwWithdrawal = storedAttemptRef.current ?? {
        withdrawalId: null,
        amount: amountText,
        idempotencyKey,
        backendStatus: null,
        signChallengeId: null,
        mintChallengeId: null,
        updatedAt: Date.now(),
      };
      persistAttempt(attempt);

      const data = await postJson("/api/paylabs/wallet/ucw/withdraw", {
        amount: attempt.amount,
        idempotencyKey: attempt.idempotencyKey,
      });
      await applyBackendResponse(data);
      if (!data.withdrawalId) throw new Error("Withdrawal response did not include a withdrawal ID");
      await continueFlow(storedAttemptRef.current, resumingExistingAttempt ? "resume" : "fresh");
    } catch (e: unknown) {
      const status = (e as Error & { status?: number }).status;
      if (status && status >= 400 && status < 500 && !storedAttemptRef.current?.withdrawalId) {
        persistAttempt(null);
      }
      setError(e instanceof Error ? e.message : "Withdrawal failed");
      if (uiPhase !== "approval_cancelled" && uiPhase !== "reconnect_required") setUiPhase("idle");
    } finally {
      submitInFlightRef.current = false;
    }
  }, [amount, applyBackendResponse, balance?.gatewayUsdc, continueFlow, gatewayBalance, persistAttempt, postJson, uiPhase]);

  const handleResume = useCallback(async () => {
    if (submitInFlightRef.current) return;
    const attempt = storedAttemptRef.current;
    if (!attempt?.withdrawalId) return;
    submitInFlightRef.current = true;
    setUiPhase("resuming");
    setError(null);
    try {
      await continueFlow(attempt, "resume");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unable to resume withdrawal");
      setUiPhase("idle");
    } finally {
      submitInFlightRef.current = false;
    }
  }, [continueFlow]);

  const handleCopy = useCallback(async () => {
    if (await copyToClipboard(walletAddress)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }
  }, [walletAddress]);

  const handleDisconnect = useCallback(async () => {
    persistAttempt(null);
    await onDisconnect();
  }, [onDisconnect, persistAttempt]);

  const handleAmountChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setAmount(event.target.value);
    setError(null);
    if (!storedAttemptRef.current) {
      setBackendStatus(null);
      setTxHash(null);
      setExplorerUrl(null);
      setCircleTransactionId(null);
    }
  }, []);

  useEffect(() => {
    needsReconnectRef.current = needsReconnectToSign;
  }, [needsReconnectToSign]);

  useEffect(() => {
    const restored = safeStoredWithdrawal(sessionStorage.getItem(key));
    if (!restored) return;
    persistAttempt(restored);
    setAmount(restored.amount);
    setBackendStatus(restored.backendStatus as WithdrawalStatus | null);
    setUiPhase("idle");
    if (restored.withdrawalId) {
      getStatus(restored.withdrawalId, restored.backendStatus === "mint_submitted")
        .then((data) => { void applyBackendResponse(data); })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "Unable to restore withdrawal"));
    }
  }, [applyBackendResponse, getStatus, key, persistAttempt]);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  return (
    <div className="pl-wallet-content-v3">
      <div className="pl-connected-hero-v3">
        <div className="pl-connected-status-v3">
          <span className="pl-connected-dot-v3" />
          <span>Creator Wallet connected</span>
        </div>

        <div className="pl-wallet-connected-address-row">
          <code className="pl-wallet-connected-address">{shortAddr(walletAddress)}</code>
          <button type="button" className={`pl-copy-pill ${copied ? "pl-copy-pill-copied" : ""}`} onClick={handleCopy}>
            {copied ? "✓ Copied" : "Copy"}
          </button>
        </div>
      </div>

      <div className="pl-summary-card-v3">
        <InfoRow label="Wallet USDC" value={balance?.walletUsdc != null ? `${balance.walletUsdc} USDC` : "Checking…"} />
        <InfoRow
          label="Gateway Balance"
          value={balance?.gatewayUsdc != null ? formatUsdc(balance.gatewayUsdc) : balance?.gatewayError ? "Unavailable" : "Checking…"}
        />
      </div>

      <div className="pl-deposit-panel-flat" style={{ marginTop: 16 }}>
        <div className="pl-deposit-title">Withdraw from Gateway</div>

        <div className="pl-deposit-input-row" style={{ marginTop: 10 }}>
          <input
            className="pl-deposit-input"
            type="number"
            min="0"
            step="0.000001"
            placeholder="Amount USDC"
            value={amount}
            onChange={handleAmountChange}
            disabled={amountLocked}
          />

          <button
            type="button"
            className="pl-primary-v3 pl-deposit-button"
            onClick={handleWithdraw}
            disabled={submitBusy || !amount || terminalBlocked || !walletId}
          >
            {submitBusy ? "Withdrawing…" : "Withdraw"}
          </button>
        </div>

        {statusMessage && (
          <p style={{ fontSize: 11, marginTop: 6, color: error ? "var(--error, #ef4444)" : statusColor(backendStatus, uiPhase) }}>
            {statusMessage}
          </p>
        )}

        {circleTransactionId && (
          <p style={{ fontSize: 10, marginTop: 4, color: "#64748b", fontVariantNumeric: "tabular-nums" }}>
            Circle transaction: {circleTransactionId.slice(0, 10)}…{circleTransactionId.slice(-6)}
          </p>
        )}

        {resumeAction && (
          <button
            type="button"
            className="pl-eoa-fallback-v3"
            onClick={needsReconnectToSign ? onReconnect : handleResume}
            disabled={submitBusy}
            style={{ marginTop: 8 }}
          >
            {needsReconnectToSign ? "Reconnect Creator Wallet" : resumeLabel}
          </button>
        )}

        {explorerUrl && (
          <a href={explorerUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", marginTop: 6, fontSize: 11, fontWeight: 700 }}>
            View transaction ↗
          </a>
        )}
      </div>

      <button type="button" className="pl-primary-v3" onClick={onRefreshBalance} style={{ marginTop: 16 }}>
        Refresh Balance
      </button>

      <button type="button" className="pl-eoa-fallback-v3" onClick={handleDisconnect} style={{ marginTop: 8 }}>
        Disconnect Creator Wallet
      </button>
    </div>
  );
}
