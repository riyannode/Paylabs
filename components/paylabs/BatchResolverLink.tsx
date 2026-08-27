"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { hrefFromTx } from "@/lib/paylabs/x402/payment-links";

type BatchResolverLinkProps = {
  runId: string;
  paymentEventId?: string;
  paymentScope?: "preflight";
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
  batchTxHash?: string | null;
  batchExplorerUrl?: string | null;
  matched_by?: string | null;
  matchedBy?: string | null;
};

function batchLinkTitle(matchedBy: string | null): string {
  if (matchedBy === "circle_official_txhash") return "Circle-linked Gateway batch transaction";
  if (matchedBy === "legacy_arc_submitBatch_corroborated") return "Gateway batch resolved from on-chain evidence";
  return "Open the Arc Gateway batch transaction linked to this x402 payment";
}

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
      return "Batch pending";
    case "gateway_fetch_failed":
    case "gateway_fetch_error":
      return "Gateway lookup failed";
    case "failed":
      return "Batch unavailable";
    case "completed":
    case "confirmed":
    case "settled":
      return "Batch pending";
    default:
      return "Batch pending";
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
  paymentEventId,
  paymentScope,
  initialBatchExplorerUrl,
  initialBatchTxHash,
  directExplorerUrl,
  directTxHash,
}: BatchResolverLinkProps) {
  const [batchUrl, setBatchUrl] = useState<string | null>(
    // Historical cached links are not settlement proof. A settlement-scoped
    // resolver response must establish the link for this row.
    null,
  );
  const [batchHash, setBatchHash] = useState<string | null>(
    null,
  );
  const [resolverStatus, setResolverStatus] = useState<string | null>(null);
  const [matchedBy, setMatchedBy] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const autoAttemptStartedRef = useRef(false);

  const handleResolverClick = useCallback(async () => {
    if (fetching) return;
    setFetching(true);
    try {
      const res = await fetch(
        paymentEventId
          ? `/api/paylabs/x402/payment-events/${encodeURIComponent(paymentEventId)}/batch-tx`
          : paymentScope === "preflight"
            ? `/api/paylabs/runs/${encodeURIComponent(runId)}/preflight-batch-tx`
            : `/api/paylabs/x402/runs/${encodeURIComponent(runId)}/batch-tx`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const data: ResolverResult = await res.json();
      setResolverStatus(data.status ?? null);
      setMatchedBy(data.matched_by ?? data.matchedBy ?? null);
      const resolvedBatchUrl = data.batch_explorer_url ?? data.batchExplorerUrl;
      const resolvedBatchHash = data.batch_tx_hash ?? data.batchTxHash;
      if (resolvedBatchUrl && resolvedBatchHash) {
        setBatchUrl(resolvedBatchUrl);
        setBatchHash(resolvedBatchHash);
      }
    } catch {
      // silent — dashboard stays quiet
    } finally {
      setFetching(false);
    }
  }, [runId, paymentEventId, paymentScope, fetching]);

  // Validate URLs against explorer allowlist via shared helper
  const directHref = hrefFromTx(directExplorerUrl, directTxHash);
  const batchHref = hrefFromTx(batchUrl, batchHash);
  const label = statusLabel(resolverStatus, !!batchHref);

  // Auto-trigger exactly once on mount if not yet resolved, with random jitter
  // (0-3s) so many pending rows on the same page do not all fire at once.
  useEffect(() => {
    const delay = Math.random() * 3000;
    const timer = setTimeout(() => {
      if (autoAttemptStartedRef.current) return;
      autoAttemptStartedRef.current = true;
      void handleResolverClick();
    }, delay);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


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
          title={batchLinkTitle(matchedBy)}
          aria-label={`${batchLinkTitle(matchedBy)} ↗️`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: "var(--success, #22c55e)",
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          Batch payment ↗️
        </a>
      )}

      {/* Status text */}
      {!batchHref && resolverStatus !== null && (label || resolverStatus) && (
        <span
          title="Waiting for the on-chain Gateway batch transaction"
          aria-label="paid Batch pending. Waiting for the on-chain Gateway batch transaction"
          style={{
            fontSize: 10,
            color: "var(--muted, #888)",
          }}
        >
          {label || "Batch pending"}
        </span>
      )}
    </div>
  );
}
