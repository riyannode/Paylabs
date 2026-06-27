"use client";

import { useCallback, useState } from "react";
import { hrefFromTx } from "@/lib/paylabs/x402/payment-links";

type BatchStatus = "settled" | "queued" | "pending";

type BatchPaymentLinkProps = {
  runId: string;
  initialBatchExplorerUrl?: string | null;
  initialBatchTxHash?: string | null;
  batchStatus?: BatchStatus;
};

type ResolverResult = {
  ok: boolean;
  status?: string;
  batch_tx_hash?: string | null;
  batch_explorer_url?: string | null;
};

function batchStatusLabel(status?: string | null, fallback?: BatchStatus): string {
  if (fallback === "settled") return "Batch settled";
  if (status === "pending" || status === "received" || status === "processing" || status === "queued") {
    return "Batch queued";
  }
  if (status === "gateway_fetch_failed" || status === "gateway_fetch_error") {
    return "Batch lookup unavailable";
  }
  if (status === "missing_settlement_id") return "Batch pending";
  if (status === "unresolved" || status === "completed" || status === "confirmed" || status === "settled") {
    return "Batch pending";
  }
  if (fallback === "queued") return "Batch queued";
  return "Batch pending";
}

export default function BatchPaymentLink({
  runId,
  initialBatchExplorerUrl,
  initialBatchTxHash,
  batchStatus,
}: BatchPaymentLinkProps) {
  const [batchUrl, setBatchUrl] = useState<string | null>(initialBatchExplorerUrl ?? null);
  const [batchHash, setBatchHash] = useState<string | null>(initialBatchTxHash ?? null);
  const [resolverStatus, setResolverStatus] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const href = hrefFromTx(batchUrl, batchHash);

  const checkBatch = useCallback(async () => {
    if (checking || href) return;
    setChecking(true);

    try {
      const res = await fetch(`/api/paylabs/x402/runs/${encodeURIComponent(runId)}/batch-tx`, {
        cache: "no-store",
      });

      if (!res.ok) {
        setResolverStatus("gateway_fetch_failed");
        return;
      }

      const data: ResolverResult = await res.json();
      setResolverStatus(data.status ?? null);

      if (data.batch_explorer_url && data.batch_tx_hash) {
        setBatchUrl(data.batch_explorer_url);
        setBatchHash(data.batch_tx_hash);
      }
    } catch {
      setResolverStatus("gateway_fetch_error");
    } finally {
      setChecking(false);
    }
  }, [checking, href, runId]);

  if (href) {
    return (
      <a className="pl-batch-payment-anchor" href={href} target="_blank" rel="noopener noreferrer">
        Batch Payment ↗
      </a>
    );
  }

  return (
    <div className="pl-batch-payment-link">
      <button type="button" onClick={checkBatch} disabled={checking}>
        {checking ? "Checking…" : resolverStatus ? "Refresh batch status" : "Check batch"}
      </button>
      <span>{batchStatusLabel(resolverStatus, batchStatus)}</span>
    </div>
  );
}
