import type { ServiceName } from "../agent-services/types";
import { isValidServiceName } from "../agent-services/registry";
import type { OfficeAgentId, OfficePhase } from "./types";

export interface OfficeAgentDefinition {
  id: OfficeAgentId;
  label: string;
  shortLabel: string;
  phase: OfficePhase;
  department: "executive" | "discovery" | "payment" | "settlement";
  desk: { x: number; y: number };
  idle: { x: number; y: number };
  color: string;
}

type ServiceOfficeAgentId = Exclude<OfficeAgentId, "brain_planner">;

const SERVICE_AGENT_IDS: ReadonlySet<ServiceOfficeAgentId> = new Set<ServiceOfficeAgentId>([
  "intent_planner",
  "query_builder",
  "signal_scout_basics",
  "signal_scout",
  "intent_matcher",
  "source_verifier",
  "value_allocator",
  "trust_verifier",
  "payment_decider",
  "creator_attribution",
  "advanced_evidence_evaluator",
  "creator_payout_router",
]);

export function isOfficeAgentId(value: string): value is OfficeAgentId {
  return value === "brain_planner" || (isValidServiceName(value) && SERVICE_AGENT_IDS.has(value));
}

export function officeAgentIdFromServiceName(serviceName: string): ServiceName | null {
  if (!isValidServiceName(serviceName)) return null;
  return SERVICE_AGENT_IDS.has(serviceName) ? serviceName : null;
}

export const OFFICE_AGENTS: Record<OfficeAgentId, OfficeAgentDefinition> = {
  brain_planner: {
    id: "brain_planner",
    label: "Brain Planner",
    shortLabel: "Brain",
    phase: "brain",
    department: "executive",
    desk: { x: 150, y: 10 },
    idle: { x: 150, y: 10 },
    color: "#8b5cf6",
  },
  intent_planner: {
    id: "intent_planner",
    label: "Intent Planner",
    shortLabel: "Intent",
    phase: "discovery_planner",
    department: "discovery",
    desk: { x: 80, y: 150 },
    idle: { x: 120, y: 365 },
    color: "#3b82f6",
  },
  query_builder: {
    id: "query_builder",
    label: "Query Builder",
    shortLabel: "Query",
    phase: "discovery_planner",
    department: "discovery",
    desk: { x: 170, y: 150 },
    idle: { x: 155, y: 365 },
    color: "#2563eb",
  },
  signal_scout_basics: {
    id: "signal_scout_basics",
    label: "Signal Scout Basics",
    shortLabel: "Scout Basic",
    phase: "discovery_planner",
    department: "discovery",
    desk: { x: 80, y: 240 },
    idle: { x: 190, y: 365 },
    color: "#0ea5e9",
  },
  signal_scout: {
    id: "signal_scout",
    label: "Signal Scout",
    shortLabel: "Scout",
    phase: "discovery_planner",
    department: "discovery",
    desk: { x: 170, y: 240 },
    idle: { x: 225, y: 365 },
    color: "#06b6d4",
  },
  intent_matcher: {
    id: "intent_matcher",
    label: "Intent Matcher",
    shortLabel: "Matcher",
    phase: "payment_decision",
    department: "payment",
    desk: { x: 340, y: 150 },
    idle: { x: 260, y: 365 },
    color: "#f59e0b",
  },
  source_verifier: {
    id: "source_verifier",
    label: "Source Verifier",
    shortLabel: "Verifier",
    phase: "payment_decision",
    department: "payment",
    desk: { x: 430, y: 150 },
    idle: { x: 295, y: 365 },
    color: "#f97316",
  },
  value_allocator: {
    id: "value_allocator",
    label: "Value Allocator",
    shortLabel: "Value",
    phase: "payment_decision",
    department: "payment",
    desk: { x: 520, y: 150 },
    idle: { x: 330, y: 365 },
    color: "#fb923c",
  },
  trust_verifier: {
    id: "trust_verifier",
    label: "Trust Verifier",
    shortLabel: "Trust",
    phase: "payment_decision",
    department: "payment",
    desk: { x: 385, y: 240 },
    idle: { x: 120, y: 385 },
    color: "#ea580c",
  },
  payment_decider: {
    id: "payment_decider",
    label: "Payment Decider",
    shortLabel: "Decider",
    phase: "payment_decision",
    department: "payment",
    desk: { x: 490, y: 240 },
    idle: { x: 155, y: 385 },
    color: "#dc2626",
  },
  creator_attribution: {
    id: "creator_attribution",
    label: "Creator Attribution",
    shortLabel: "Attrib",
    phase: "settlement_memory",
    department: "settlement",
    desk: { x: 690, y: 150 },
    idle: { x: 190, y: 385 },
    color: "#22c55e",
  },
  advanced_evidence_evaluator: {
    id: "advanced_evidence_evaluator",
    label: "Evidence Evaluator",
    shortLabel: "Evidence",
    phase: "settlement_memory",
    department: "settlement",
    desk: { x: 790, y: 150 },
    idle: { x: 225, y: 385 },
    color: "#16a34a",
  },
  creator_payout_router: {
    id: "creator_payout_router",
    label: "Creator Payout Router",
    shortLabel: "Payout",
    phase: "settlement_memory",
    department: "settlement",
    desk: { x: 740, y: 240 },
    idle: { x: 260, y: 385 },
    color: "#15803d",
  },
};

export const OFFICE_STATIONS = {
  gateway: { x: 605, y: 245 },
  creatorPayout: { x: 748, y: 245 },
  treasuryReserve: { x: 842, y: 245 },
  lounge: { x: 500, y: 350 },
  error: { x: 870, y: 360 },
};

export function assertOfficeRegistryMatchesServiceRegistry(): void {
  for (const agentId of Object.keys(OFFICE_AGENTS)) {
    if (agentId === "brain_planner") continue;
    if (!isValidServiceName(agentId)) {
      throw new Error(`Office agent ${agentId} is not an actual PayLabs ServiceName`);
    }
  }
}
