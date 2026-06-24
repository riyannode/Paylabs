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
  status: string;
  batch_tx_hash?: string | null;
  batch_explorer_url?: string | null;
};

/**
 * Renders payment links for dashboard x402 Service Payments and Receipts.
 *
 * - x402 payment ↗ (direct explorer link via hrefFromTx)
 * - Batch resolver ↗ (clickable, fetches once on click)
 * - Batch payment ↗ (when resolved, via hrefFromTx)
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
  const [fetched, setFetched] = useState(!!initialBatchExplorerUrl);

  const handleResolverClick = useCallback(async () => {
    if (fetched || fetching) return;
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
      setFetched(true);
    } catch {
      // silent — dashboard stays quiet
    } finally {
      setFetching(false);
    }
  }, [runId, fetched, fetching]);

  // Validate URLs against explorer allowlist via shared helper
  const directHref = hrefFromTx(directExplorerUrl, directTxHash);
  const batchHref = hrefFromTx(batchUrl, batchHash);

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

      {/* Batch resolver link */}
      <a
        href={`/api/paylabs/x402/runs/${encodeURIComponent(runId)}/batch-tx`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => {
          void handleResolverClick();
        }}
        style={{
          color: "var(--muted, #888)",
          textDecoration: "none",
          whiteSpace: "nowrap",
        }}
      >
        Batch resolver ↗
      </a>

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

      {/* Status badge */}
      {!batchHref && resolverStatus && (
        <span
          style={{
            fontSize: 10,
            padding: "1px 6px",
            borderRadius: 4,
            background: "var(--warning-bg, rgba(234,179,8,0.1))",
            color: "var(--warning, #eab308)",
            width: "fit-content",
          }}
        >
          {resolverStatus}
        </span>
      )}
    </div>
  );
}
