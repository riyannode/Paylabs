import type { ServiceName } from "../agent-services/types";
import { isValidServiceName } from "../agent-services/registry";
import type { OfficeAgentId, OfficeMacroAgentId, OfficePhase } from "./types";

export interface OfficeAgentDefinition {
  id: OfficeAgentId;
  label: string;
  shortLabel: string;
  phase: OfficePhase;
  department: "executive" | "discovery" | "payment" | "settlement" | "macro_hub";
  desk: { x: number; y: number };
  idle: { x: number; y: number };
  color: string;
}

type ServiceOfficeAgentId = Exclude<OfficeAgentId, "brain_planner" | OfficeMacroAgentId>;

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
  if (value === "brain_planner") return true;
  if (isOfficeMacroAgentId(value)) return true;
  return isValidServiceName(value) && SERVICE_AGENT_IDS.has(value);
}

export function officeAgentIdFromServiceName(serviceName: string): ServiceName | null {
  if (!isValidServiceName(serviceName)) return null;
  return SERVICE_AGENT_IDS.has(serviceName) ? serviceName : null;
}

// ── Macro agent definitions (single source of truth) ──────────────
export interface OfficeMacroAgentDefinition {
  id: OfficeMacroAgentId;
  label: string;
  shortLabel: string;
  station: { x: number; y: number };
  brainApproach: { x: number; y: number };
  department: "macro_hub";
  color: string;
}

const OFFICE_MACRO_AGENT_IDS: ReadonlySet<OfficeMacroAgentId> = new Set<OfficeMacroAgentId>([
  "discovery_planner",
  "payment_decision",
  "settlement_memory",
]);

export const OFFICE_MACRO_AGENTS: Record<OfficeMacroAgentId, OfficeMacroAgentDefinition> = {
  discovery_planner: {
    id: "discovery_planner",
    label: "Discovery Node",
    shortLabel: "D-NODE",
    station: { x: 440, y: 390 },
    brainApproach: { x: 398, y: 350 },
    department: "macro_hub",
    color: "#22d3ee",
  },
  payment_decision: {
    id: "payment_decision",
    label: "Payment Node",
    shortLabel: "P-NODE",
    station: { x: 480, y: 364 },
    brainApproach: { x: 560, y: 330 },
    department: "macro_hub",
    color: "#f97316",
  },
  settlement_memory: {
    id: "settlement_memory",
    label: "Settlement Node",
    shortLabel: "S-NODE",
    station: { x: 485, y: 436 },
    brainApproach: { x: 560, y: 436 },
    department: "macro_hub",
    color: "#22c55e",
  },
};

function macroAgentDef(m: OfficeMacroAgentDefinition): OfficeAgentDefinition {
  return {
    id: m.id,
    label: m.label,
    shortLabel: m.shortLabel,
    phase: m.id,
    department: m.department,
    desk: { ...m.station },
    idle: { ...m.station },
    color: m.color,
  };
}

export function isOfficeMacroAgentId(value: string): value is OfficeMacroAgentId {
  return OFFICE_MACRO_AGENT_IDS.has(value as OfficeMacroAgentId);
}

// ── Office agents (brain + child services + macro nodes) ───────────
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
    desk: { x: 69, y: 139 },
    idle: { x: 100, y: 345 },
    color: "#3b82f6",
  },
  query_builder: {
    id: "query_builder",
    label: "Query Builder",
    shortLabel: "Query",
    phase: "discovery_planner",
    department: "discovery",
    desk: { x: 157, y: 139 },
    idle: { x: 135, y: 345 },
    color: "#2563eb",
  },
  signal_scout_basics: {
    id: "signal_scout_basics",
    label: "Signal Scout Basics",
    shortLabel: "Scout Basic",
    phase: "discovery_planner",
    department: "discovery",
    desk: { x: 69, y: 205 },
    idle: { x: 170, y: 345 },
    color: "#0ea5e9",
  },
  signal_scout: {
    id: "signal_scout",
    label: "Signal Scout",
    shortLabel: "Scout",
    phase: "discovery_planner",
    department: "discovery",
    desk: { x: 157, y: 205 },
    idle: { x: 205, y: 345 },
    color: "#06b6d4",
  },
  intent_matcher: {
    id: "intent_matcher",
    label: "Intent Matcher",
    shortLabel: "Matcher",
    phase: "payment_decision",
    department: "payment",
    desk: { x: 344, y: 101 },
    idle: { x: 240, y: 345 },
    color: "#f59e0b",
  },
  source_verifier: {
    id: "source_verifier",
    label: "Source Verifier",
    shortLabel: "Verifier",
    phase: "payment_decision",
    department: "payment",
    desk: { x: 430, y: 101 },
    idle: { x: 275, y: 345 },
    color: "#f97316",
  },
  value_allocator: {
    id: "value_allocator",
    label: "Value Allocator",
    shortLabel: "Value",
    phase: "payment_decision",
    department: "payment",
    desk: { x: 516, y: 101 },
    idle: { x: 310, y: 345 },
    color: "#fb923c",
  },
  trust_verifier: {
    id: "trust_verifier",
    label: "Trust Verifier",
    shortLabel: "Trust",
    phase: "payment_decision",
    department: "payment",
    desk: { x: 344, y: 167 },
    idle: { x: 100, y: 365 },
    color: "#ea580c",
  },
  payment_decider: {
    id: "payment_decider",
    label: "Payment Decider",
    shortLabel: "Decider",
    phase: "payment_decision",
    department: "payment",
    desk: { x: 430, y: 167 },
    idle: { x: 135, y: 365 },
    color: "#dc2626",
  },
  creator_attribution: {
    id: "creator_attribution",
    label: "Creator Attribution",
    shortLabel: "Attrib",
    phase: "settlement_memory",
    department: "settlement",
    desk: { x: 714, y: 101 },
    idle: { x: 170, y: 365 },
    color: "#22c55e",
  },
  advanced_evidence_evaluator: {
    id: "advanced_evidence_evaluator",
    label: "Evidence Evaluator",
    shortLabel: "Evidence",
    phase: "settlement_memory",
    department: "settlement",
    desk: { x: 802, y: 101 },
    idle: { x: 205, y: 365 },
    color: "#16a34a",
  },
  creator_payout_router: {
    id: "creator_payout_router",
    label: "Creator Payout Router",
    shortLabel: "Payout",
    phase: "settlement_memory",
    department: "settlement",
    desk: { x: 714, y: 167 },
    idle: { x: 240, y: 365 },
    color: "#15803d",
  },
  // Macro nodes derived from OFFICE_MACRO_AGENTS (single source of truth)
  discovery_planner: macroAgentDef(OFFICE_MACRO_AGENTS.discovery_planner),
  payment_decision: macroAgentDef(OFFICE_MACRO_AGENTS.payment_decision),
  settlement_memory: macroAgentDef(OFFICE_MACRO_AGENTS.settlement_memory),
};

export const OFFICE_STATIONS = {
  gateway: { x: 498, y: 340 },
  creatorPayout: { x: 733, y: 340 },
  treasuryReserve: { x: 819, y: 340 },
  lounge: { x: 200, y: 369 },
  error: { x: 862, y: 355 },
};

export function assertOfficeRegistryMatchesServiceRegistry(): void {
  for (const agentId of Object.keys(OFFICE_AGENTS)) {
    if (agentId === "brain_planner") continue;
    if (isOfficeMacroAgentId(agentId)) continue;
    if (!isValidServiceName(agentId)) {
      throw new Error(`Office agent ${agentId} is not an actual PayLabs ServiceName`);
    }
  }
}
