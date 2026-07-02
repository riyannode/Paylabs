/**
 * PayLabs Chat — Shared Types
 *
 * Types extracted from app/paylabs-chat-client.tsx so that
 * presentational components can import them without pulling in
 * the parent component's full dependency tree.
 */

export type SourceLink = {
  title: string;
  url: string;
  domain: string | null;
  summary: string;
  rank: number;
  relevance_score: number;
};

export type SafeRunResult = {
  ok: boolean;
  runId: string | null;
  status: string | null;
  requestedTier: string | null;
  tier: string | null;
  effectiveTier: string | null;
  brainRouteTierHint: string | null;
  entryPaymentStatus: string | null;
  plannedCostUsdc: number | null;
  paidEdges: number;
  totalEdges: number;
  receiptReady: boolean;
  safeSummary: string;
  assistantResponse: string | null;
  userVisibleReasoning: string | null;
  brainRationale: string | null;
  sourceFinalAnswer: string | null;
  lockedNodes: string[];
  lockedServices: string[];
  tierDecisionReason: string | null;
  sourcesUsed: SourceLink[];
  // Payment link fields — chat renders direct explorer link only, never settlement UUID
  entryExplorerUrl: string | null;
  entrySettlementId: string | null;
  entryTransferStatus: string | null;
  entryGatewayAccepted: boolean;
  entryBatchExplorerUrl: string | null;
  entryBatchTxHash: string | null;
};

export type ChatMessage =
  | { id: string; role: "user"; content: string; createdAt: number }
  | {
      id: string;
      role: "assistant";
      status: "running" | "done" | "error";
      result?: SafeRunResult | null;
      error?: string | null;
      createdAt: number;
    };
