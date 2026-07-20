import type { ServiceName } from "../agent-services/types";

export type OfficeAgentStatus =
  | "idle"
  | "queued"
  | "walking"
  | "planning"
  | "searching"
  | "verifying"
  | "calculating"
  | "paying"
  | "settling"
  | "completed"
  | "failed";

export type OfficeEventType =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "phase.started"
  | "phase.completed"
  | "agent.started"
  | "agent.progress"
  | "agent.completed"
  | "agent.failed"
  | "x402.requested"
  | "x402.settled"
  | "x402.failed"
  | "creator.paid"
  | "treasury.retained";

export type OfficeMacroAgentId =
  | "discovery_planner"
  | "payment_decision"
  | "settlement_memory";

export type OfficeAgentId =
  | "brain_planner"
  | OfficeMacroAgentId
  | ServiceName;

export function isOfficeMacroAgentId(value: string): value is OfficeMacroAgentId {
  return value === "discovery_planner" || value === "payment_decision" || value === "settlement_memory";
}

export type OfficePhase =
  | "brain"
  | "discovery_planner"
  | "payment_decision"
  | "settlement_memory";

export interface OfficePaymentMeta {
  amountUsdc: string;
  status: "pending" | "settled" | "failed";
  txHash?: string | null;
  settlementId?: string | null;
  explorerUrl?: string | null;
}

export interface PayLabsOfficeEvent {
  id: string;
  runId: string;
  sequence: number;
  type: OfficeEventType;
  agentId?: OfficeAgentId;
  phase?: OfficePhase;
  status?: OfficeAgentStatus;
  title: string;
  message?: string | null;
  payment?: OfficePaymentMeta | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface OfficeAgentViewState {
  id: OfficeAgentId;
  status: OfficeAgentStatus;
  message?: string;
  x: number;
  y: number;
  facing: "left" | "right";
  lastEventSequence: number;
  visitingReturn?: { x: number; y: number };
}

export interface OfficeRunSummary {
  runId: string | null;
  tier: string | null;
  plannedCostUsdc: number | null;
  paidEdges: number;
  totalEdges: number;
  receiptReady: boolean;
  status: string | null;
}
