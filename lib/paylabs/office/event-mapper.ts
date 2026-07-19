import type { OfficeAgentStatus, OfficePhase } from "./types";
import type { ServiceName } from "../agent-services/types";
import { isValidServiceName } from "../agent-services/registry";
import { officeAgentIdFromServiceName } from "./registry";

export function phaseFromMacroNode(macroNode: string): OfficePhase {
  if (macroNode === "discovery_planner") return "discovery_planner";
  if (macroNode === "payment_decision") return "payment_decision";
  if (macroNode === "settlement_memory") return "settlement_memory";
  return "brain";
}

export function statusFromServiceName(serviceName: string): OfficeAgentStatus {
  if (serviceName === "intent_matcher") return "verifying";
  if (serviceName.includes("scout")) return "searching";
  if (serviceName.includes("verifier")) return "verifying";
  if (serviceName.includes("allocator")) return "calculating";
  if (serviceName.includes("decider")) return "calculating";
  if (serviceName.includes("payout")) return "settling";
  if (serviceName.includes("attribution")) return "verifying";
  if (serviceName.includes("evidence")) return "verifying";
  if (serviceName.includes("query")) return "planning";
  if (serviceName.includes("intent")) return "planning";
  return "queued";
}

export function isOfficeServiceName(value: string): value is ServiceName {
  return isValidServiceName(value) && officeAgentIdFromServiceName(value) !== null;
}
