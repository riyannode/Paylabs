"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import BatchPaymentLink from "@/components/paylabs/BatchPaymentLink";

type DisplayStatus = "paid" | "settled" | "pending" | "failed";
type BatchStatus = "settled" | "queued" | "pending";

type ReceiptListItem = {
  discoveryRunId: string;
  receiptId: string;
  createdAt: string;
  selectedTier: string | null;
  amountUsdc: number | null;
  paymentCount: number | null;
  sourceCount?: number | null;
  displayStatus: DisplayStatus;
  batchStatus: BatchStatus;
};

type CreatorReceiptRow = {
  id: string;
  routeTier: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  creatorWallet: string | null;
  status: string | null;
  plannedAmountUsdc: number | null;
  actualAmountUsdc: number | null;
  splitPolicy: string | null;
  safeSummary: string | null;
  createdAt: string | null;
};

type SourceReceiptRow = {
  id: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  publisher: string | null;
  creatorWallet: string | null;
  claimStatus: string | null;
  eligibilityStatus: string | null;
  finalScore: number | null;
  riskScore: number | null;
  attributionReason: string | null;
  createdAt: string | null;
};

type ReceiptDetail = {
  discoveryRunId: string;
  receiptId: string;
  createdAt: string;
  selectedTier: string | null;
  plannedCostUsdc: number | null;
  actualSettledUsdc: number | null;
  remainingBudgetUsdc: number | null;
  paymentCount: number | null;
  safeReceiptSummary: string | null;
  executionFeeUsdc: number | null;
  plannedCreatorPoolUsdc: number | null;
  actualCreatorPaidUsdc: number | null;
  pendingCreatorReserveUsdc: number | null;
  creatorPayoutStatus: string | null;
  advancedEvaluatorUsed: boolean | null;
  advancedEvaluatorConfidence: number | null;
  advancedEvaluatorRationale: string | null;
  whyTwoSourcesNeeded: string | null;
  lastBatchExplorerUrl: string | null;
  lastBatchTxHash: string | null;
  displayStatus: DisplayStatus;
  batchStatus: BatchStatus;
  userCostUsdc?: number | null;
  creators: CreatorReceiptRow[];
  sources: SourceReceiptRow[];
};

type Props = { initialRunId: string | null };
type StatusFilter = "all" | DisplayStatus;

function formatUsdc(value: number | null | undefined): string {
  return `${Number(value || 0).toFixed(6)} USDC`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function domainFromUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function statusClass(status: DisplayStatus): string {
  if (status === "settled" || status === "paid") return "badge-success";
  if (status === "failed") return "badge-danger";
  return "badge-warning";
}

function label(value: string | null | undefined): string {
  return value || "—";
}

async function fetchReceiptDetail(runId: string): Promise<ReceiptDetail> {
  const res = await fetch(`/api/paylabs/runs/${encodeURIComponent(runId)}/receipt`, { cache: "no-store" });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || "receipt_fetch_failed");
  return data.receipt;
}

function PaymentSection({ detail }: { detail: ReceiptDetail }) {
  return (
    <section className="pl-receipt-section">
      <h3>Payment</h3>
      <dl>
        <div><dt>Network</dt><dd>Arc Testnet</dd></div>
        <div><dt>Tier</dt><dd>{label(detail.selectedTier)}</dd></div>
        <div><dt>Planned Run Cost</dt><dd>{formatUsdc(detail.plannedCostUsdc)}</dd></div>
        {detail.userCostUsdc != null && (
          <div><dt>User Cost</dt><dd>{formatUsdc(detail.userCostUsdc)}</dd></div>
        )}
        <div><dt>Platform x402 Volume</dt><dd>{formatUsdc(detail.actualSettledUsdc)}</dd></div>
        <div><dt>Payments</dt><dd>{detail.paymentCount ?? 0}</dd></div>
      </dl>
      {detail.safeReceiptSummary && <p className="muted pl-receipt-summary">{detail.safeReceiptSummary}</p>}
    </section>
  );
}

function CreatorsSection({ detail }: { detail: ReceiptDetail }) {
  const tier = (detail.selectedTier || "").toLowerCase();

  return (
    <section className="pl-receipt-section">
      <h3>Creators</h3>
      {tier === "easy" || tier === "beginner" ? (
        <p className="muted">No creator payouts for this tier</p>
      ) : detail.creators.length === 0 ? (
        <div className="pl-safe-empty">
          <p>No eligible creator payout</p>
          <span>Creator Cut: {formatUsdc(detail.actualCreatorPaidUsdc)}</span>
          <span>Treasury / Unallocated: {formatUsdc(detail.pendingCreatorReserveUsdc)}</span>
        </div>
      ) : (
        <div className="pl-receipt-rows">
          {detail.creators.map((creator) => (
            <article key={creator.id} className="pl-receipt-row">
              <strong>{creator.sourceTitle || domainFromUrl(creator.sourceUrl) || "Creator payout"}</strong>
              <span>{formatUsdc(creator.actualAmountUsdc ?? creator.plannedAmountUsdc)}</span>
              <span className="muted">{label(creator.status)}{creator.creatorWallet ? ` · ${creator.creatorWallet}` : ""}</span>
              {creator.safeSummary && <small>{creator.safeSummary}</small>}
            </article>
          ))}
        </div>
      )}
      {detail.advancedEvaluatorUsed && (
        <p className="muted pl-receipt-summary">
          Advanced evaluator{detail.advancedEvaluatorConfidence != null ? ` · confidence ${detail.advancedEvaluatorConfidence}` : ""}
          {detail.advancedEvaluatorRationale ? ` — ${detail.advancedEvaluatorRationale}` : ""}
        </p>
      )}
      {detail.whyTwoSourcesNeeded && <p className="muted pl-receipt-summary">{detail.whyTwoSourcesNeeded}</p>}
    </section>
  );
}

function SourcesSection({ detail }: { detail: ReceiptDetail }) {
  const hasPaymentInfo = detail.paymentCount != null && detail.paymentCount > 0;
  return (
    <section className="pl-receipt-section">
      <h3>Sources</h3>
      {detail.sources.length === 0 ? (
        <div className="pl-safe-empty">
          {hasPaymentInfo ? (
            <>
              <p>Sources used during this run</p>
              <span className="muted">Creator-monetized sources: 0</span>
            </>
          ) : (
            <p>No source data available for this run</p>
          )}
        </div>
      ) : (
        <div className="pl-receipt-rows">
          {detail.sources.map((source) => (
            <article key={source.id} className="pl-receipt-row">
              <strong>{source.sourceTitle || domainFromUrl(source.sourceUrl) || "Source"}</strong>
              <span>{source.publisher || domainFromUrl(source.sourceUrl) || "Publisher unavailable"}</span>
              <span className="muted">{label(source.eligibilityStatus)} · {label(source.claimStatus)}</span>
              {source.attributionReason && <small>{source.attributionReason}</small>}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function BatchSection({ detail }: { detail: ReceiptDetail }) {
  return (
    <section className="pl-receipt-section">
      <h3>Batch</h3>
      <dl>
        <div><dt>Status</dt><dd style={{ textTransform: "capitalize" }}>{detail.batchStatus}</dd></div>
      </dl>
      <BatchPaymentLink
        runId={detail.discoveryRunId}
        initialBatchExplorerUrl={detail.lastBatchExplorerUrl}
        initialBatchTxHash={detail.lastBatchTxHash}
        batchStatus={detail.batchStatus}
      />
    </section>
  );
}

function ReceiptCard({ item, initiallyOpen }: { item: ReceiptListItem; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [detail, setDetail] = useState<ReceiptDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDetail = useCallback(async () => {
    if (detail || loading) return;
    setLoading(true);
    setError(null);
    try {
      setDetail(await fetchReceiptDetail(item.discoveryRunId));
    } catch {
      setError("Receipt details are unavailable right now.");
    } finally {
      setLoading(false);
    }
  }, [detail, item.discoveryRunId, loading]);

  useEffect(() => {
    if (open) void loadDetail();
  }, [loadDetail, open]);

  return (
    <article className="pl-receipt-card">
      <button className="pl-receipt-card-head" type="button" onClick={() => setOpen((value) => !value)}>
        <span className={`pl-status-dot pl-status-${item.displayStatus}`} />
        <span className="pl-receipt-main">
          <strong>{item.receiptId}</strong>
          <span>{formatDate(item.createdAt)}{item.sourceCount != null ? ` · ${item.sourceCount} sources` : ""}</span>
        </span>
        <span className="data-mono pl-receipt-amount">{formatUsdc(item.amountUsdc)}</span>
        <span className={`badge ${statusClass(item.displayStatus)}`} style={{ textTransform: "capitalize" }}>{item.displayStatus}</span>
        <span className="pl-receipt-chevron">{open ? "⌃" : "⌄"}</span>
      </button>

      {open && (
        <div className="pl-receipt-expanded">
          {loading && <p className="muted">Loading receipt details…</p>}
          {error && <p className="muted">{error}</p>}
          {detail && (
            <div className="pl-receipt-grid">
              <PaymentSection detail={detail} />
              <CreatorsSection detail={detail} />
              <SourcesSection detail={detail} />
              <BatchSection detail={detail} />
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export default function ReceiptsClient({ initialRunId }: Props) {
  const [receipts, setReceipts] = useState<ReceiptListItem[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [listRes, selectedDetail] = await Promise.all([
          fetch("/api/paylabs/receipts?limit=50", { cache: "no-store" }).then((res) => res.json()),
          initialRunId ? fetchReceiptDetail(initialRunId).catch(() => null) : Promise.resolve(null),
        ]);
        if (!mounted) return;
        const list: ReceiptListItem[] = listRes.ok ? listRes.receipts : [];
        if (selectedDetail && !list.some((item) => item.discoveryRunId === selectedDetail.discoveryRunId)) {
          list.unshift({
            discoveryRunId: selectedDetail.discoveryRunId,
            receiptId: selectedDetail.receiptId,
            createdAt: selectedDetail.createdAt,
            selectedTier: selectedDetail.selectedTier,
            amountUsdc: selectedDetail.actualSettledUsdc ?? selectedDetail.plannedCostUsdc,
            paymentCount: selectedDetail.paymentCount,
            sourceCount: selectedDetail.sources.length,
            displayStatus: selectedDetail.displayStatus,
            batchStatus: selectedDetail.batchStatus,
          });
        }
        setReceipts(list);
      } catch {
        if (mounted) setError("Receipts are unavailable right now.");
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void load();
    return () => { mounted = false; };
  }, [initialRunId]);

  const visibleReceipts = useMemo(() => {
    if (filter === "all") return receipts;
    return receipts.filter((receipt) => receipt.displayStatus === filter);
  }, [filter, receipts]);

  return (
    <div className="pl-receipts-page">
      <header className="pl-receipts-header">
        <div>
          <a href="/" className="pl-back-btn">← Back to Chat</a>
          <h1 className="page-title">Receipts</h1>
          <p className="muted">Your PayLabs payment receipts and history</p>
        </div>
        <select className="input pl-receipts-filter" value={filter} onChange={(event) => setFilter(event.target.value as StatusFilter)}>
          <option value="all">All Status</option>
          <option value="paid">Paid</option>
          <option value="settled">Settled</option>
          <option value="failed">Failed</option>
          <option value="pending">Pending</option>
        </select>
      </header>

      {loading && <section className="card">Loading receipts…</section>}
      {error && <section className="card muted">{error}</section>}
      {!loading && !error && visibleReceipts.length === 0 && (
        <section className="card pl-empty-receipts">
          <h2>No receipts yet.</h2>
          <p className="muted">Run PayLabs to generate your first receipt.</p>
        </section>
      )}
      {!loading && !error && visibleReceipts.length > 0 && (
        <div className="pl-receipt-list">
          {visibleReceipts.map((receipt) => (
            <ReceiptCard
              key={receipt.discoveryRunId}
              item={receipt}
              initiallyOpen={receipt.discoveryRunId === initialRunId}
            />
          ))}
        </div>
      )}
    </div>
  );
}