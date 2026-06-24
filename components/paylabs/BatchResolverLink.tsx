"use client";

import { useState, useCallback } from "react";
import { hrefFromTx } from "@/lib/paylabs/x402/payment-links";

type BatchResolverLinkProps = {
  runId: string;
  initialBatchExplorerUrl?: string | null;
  initialBatchTxHash?: string | null;
  directExplorerUrl?: string | null;
  directTxHash?: string | null;
};

type ResolverResult = {
  ok: boolean;
  status?: string;
  direct_explorer_url?: string | null;
  batch_tx_hash?: string | null;
  batch_explorer_url?: string | null;
  matched_by?: string | null;
};

/**
 * Map resolver status to user-facing label.
 * Never shows raw status strings to the user.
 */
function statusLabel(status: string | null, batchResolved: boolean): string | null {
  if (batchResolved) return "Batch resolved";
  if (!status) return null;
  switch (status) {
    case "missing_settlement_id":
      return "No settlement captured";
    case "pending":
    case "received":
    case "processing":
    case "queued":
      return "Batch pending";
    case "unresolved":
      return "Batch tx not found yet";
    case "gateway_fetch_failed":
    case "gateway_fetch_error":
      return "Gateway lookup failed";
    case "completed":
    case "confirmed":
    case "settled":
      return "Batch tx not found yet";
    default:
      return status;
  }
}

/**
 * Renders payment links for dashboard x402 Service Payments and Receipts.
 *
 * - x402 payment ↗ (direct explorer link via hrefFromTx)
 * - Check batch / Check again button (fetches resolver API in background)
 * - Batch payment ↗ (when resolved, via hrefFromTx)
 * - Small status text when pending/missing
 *
 * Never renders raw settlement UUID, Gateway response, or secrets.
 */
export default function BatchResolverLink({
  runId,
  initialBatchExplorerUrl,
  initialBatchTxHash,
  directExplorerUrl,
  directTxHash,
}: BatchResolverLinkProps) {
  const [batchUrl, setBatchUrl] = useState<string | null>(
    initialBatchExplorerUrl ?? null,
  );
  const [batchHash, setBatchHash] = useState<string | null>(
    initialBatchTxHash ?? null,
  );
  const [resolverStatus, setResolverStatus] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  const handleResolverClick = useCallback(async () => {
    if (fetching) return;
    setFetching(true);
    try {
      const res = await fetch(
        `/api/paylabs/x402/runs/${encodeURIComponent(runId)}/batch-tx`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const data: ResolverResult = await res.json();
      setResolverStatus(data.status ?? null);
      if (data.batch_explorer_url && data.batch_tx_hash) {
        setBatchUrl(data.batch_explorer_url);
        setBatchHash(data.batch_tx_hash);
      }
    } catch {
      // silent — dashboard stays quiet
    } finally {
      setFetching(false);
    }
  }, [runId, fetching]);

  // Validate URLs against explorer allowlist via shared helper
  const directHref = hrefFromTx(directExplorerUrl, directTxHash);
  const batchHref = hrefFromTx(batchUrl, batchHash);
  const label = statusLabel(resolverStatus, !!batchHref);

  // Case E: old row with no settlement and no direct tx
  if (!directHref && !resolverStatus && !batchHref) {
    return (
      <div style={{ fontSize: 11, color: "var(--muted, #888)" }}>
        No settlement captured
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 11,
      }}
    >
      {/* Direct x402 link */}
      {directHref && (
        <a
          href={directHref}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: "var(--accent, #6366f1)",
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          x402 payment ↗
        </a>
      )}

      {/* Check batch button — hidden only when batchHref exists */}
      {!batchHref && (
        <button
          type="button"
          onClick={() => {
            void handleResolverClick();
          }}
          disabled={fetching}
          style={{
            color: "var(--muted, #888)",
            textDecoration: "none",
            whiteSpace: "nowrap",
            background: "none",
            border: "none",
            padding: 0,
            cursor: fetching ? "default" : "pointer",
            fontSize: 11,
          }}
        >
          {fetching
            ? "Checking…"
            : resolverStatus
              ? "Check again"
              : "Check batch"}
        </button>
      )}

      {/* Batch payment link (appears when resolved) */}
      {batchHref && (
        <a
          href={batchHref}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: "var(--success, #22c55e)",
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          Batch payment ↗
        </a>
      )}

      {/* Status text */}
      {!batchHref && label && (
        <span
          style={{
            fontSize: 10,
            color: "var(--muted, #888)",
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
}
