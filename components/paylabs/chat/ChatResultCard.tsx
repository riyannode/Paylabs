"use client";

import { useState } from "react";
import type { SafeRunResult } from "./types";

export function ChatResultCard({ result, onReset }: { result: SafeRunResult; onReset: () => void }) {
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
