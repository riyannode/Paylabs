"use client";

import { useState, useCallback } from "react";

type BatchResolverLinkProps = {
  runId: string;
  initialBatchExplorerUrl?: string | null;
  initialBatchTxHash?: string | null;
  directExplorerUrl?: string | null;
};

type ResolverResult = {
  status: string;
  batch_tx_hash?: string | null;
  batch_explorer_url?: string | null;
};

/**
 * Renders payment links for dashboard x402 Service Payments.
 *
 * - x402 payment ↗ (direct explorer link)
 * - Batch resolver ↗ (clickable, fetches once on click)
 * - Batch payment ↗ (when resolved)
 *
 * Never renders raw settlement UUID, Gateway response, or secrets.
 */
export default function BatchResolverLink({
  runId,
  initialBatchExplorerUrl,
  initialBatchTxHash,
  directExplorerUrl,
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

  const hasDirect = !!directExplorerUrl;
  const hasBatch = !!batchUrl;

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
      {hasDirect && (
        <a
          href={directExplorerUrl!}
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
        onClick={(e) => {
          // Fetch silently on click to update batch link
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
      {hasBatch && (
        <a
          href={batchUrl!}
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
      {!hasBatch && resolverStatus && (
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
