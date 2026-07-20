import { OFFICE_AGENTS, OFFICE_STATIONS } from "./registry";
import type { OfficeAgentId, OfficeAgentViewState, OfficeMacroAgentId, OfficeMacroBeamState, PayLabsOfficeEvent } from "./types";

export type OfficeState = Record<OfficeAgentId, OfficeAgentViewState>;

/** Time a requested beam stays active when no terminal event arrives. */
export const OFFICE_MACRO_BEAM_REQUEST_TIMEOUT_MS = 15_000;

/** Time a settled/failed beam remains visible before clearing. */
export const OFFICE_MACRO_BEAM_RESULT_DWELL_MS = 900;

/**
 * Remaining milliseconds before a beam expires.
 * Returns 0 when already expired or for invalid input.
 */
export function getMacroBeamRemainingMs(
  beam: OfficeMacroBeamState,
  nowMs: number,
): number {
  const created = Date.parse(beam.createdAt);
  if (Number.isNaN(created)) return 0;
  const lifetime =
    beam.type === "requested"
      ? OFFICE_MACRO_BEAM_REQUEST_TIMEOUT_MS
      : OFFICE_MACRO_BEAM_RESULT_DWELL_MS;
  const remaining = created + lifetime - nowMs;
  return remaining > 0 ? remaining : 0;
}

export function createInitialOfficeState(): OfficeState {
  return Object.fromEntries(
    Object.values(OFFICE_AGENTS).map((agent) => [
      agent.id,
      {
        id: agent.id,
        status: "idle",
        x: agent.idle.x,
        y: agent.idle.y,
        facing: "right",
        lastEventSequence: 0,
      },
    ]),
  ) as OfficeState;
}

function destinationFor(event: PayLabsOfficeEvent, agentId: OfficeAgentId): { x: number; y: number } {
  if (agentId === "brain_planner") {
    return OFFICE_AGENTS.brain_planner.desk;
  }

  // Macro agents remain at their permanent station for all statuses
  if (agentId === "discovery_planner" || agentId === "payment_decision" || agentId === "settlement_memory") {
    return OFFICE_AGENTS[agentId].desk;
  }

  if (event.type === "x402.requested" || event.type === "x402.settled") {
    return OFFICE_STATIONS.gateway;
  }
  if (event.type === "creator.paid") {
    return OFFICE_STATIONS.creatorPayout;
  }
  if (event.type === "treasury.retained") {
    return OFFICE_STATIONS.treasuryReserve;
  }
  if (event.status === "failed" || event.type === "run.failed" || event.type === "agent.failed") {
    return OFFICE_STATIONS.error;
  }
  if (event.status === "completed" || event.type === "agent.completed" || event.type === "run.completed") {
    return OFFICE_AGENTS[agentId].desk;
  }
  return OFFICE_AGENTS[agentId].desk;
}

function isMacroBeamEvent(
  event: PayLabsOfficeEvent,
  agentId: OfficeAgentId,
): event is PayLabsOfficeEvent & { type: "x402.requested" | "x402.settled" | "x402.failed" } {
  if (
    agentId !== "discovery_planner" &&
    agentId !== "payment_decision" &&
    agentId !== "settlement_memory"
  ) {
    return false;
  }
  return (
    event.type === "x402.requested" ||
    event.type === "x402.settled" ||
    event.type === "x402.failed"
  );
}

function beamTypeFromEventType(
  eventType: "x402.requested" | "x402.settled" | "x402.failed",
): OfficeMacroBeamState["type"] {
  if (eventType === "x402.requested") return "requested";
  if (eventType === "x402.settled") return "settled";
  return "failed";
}

function beamStatusFromEventType(
  eventType: "x402.requested" | "x402.settled" | "x402.failed",
): "paying" | "completed" | "failed" {
  if (eventType === "x402.requested") return "paying";
  if (eventType === "x402.settled") return "completed";
  return "failed";
}

export function reduceOfficeEvent(state: OfficeState, event: PayLabsOfficeEvent): OfficeState {
  if (!event.agentId) return state;
  const current = state[event.agentId];
  if (!current) return state;
  if (event.sequence <= current.lastEventSequence) return state;
  const destination = destinationFor(event, event.agentId);
  const isVisit = isVisitEvent(event.type);
  const isDeskDwell = !isVisit && isDeskDwellEvent(event, event.agentId);

  // Compute beam update for macro agents
  let beam: OfficeMacroBeamState | undefined = current.beam;
  if (isMacroBeamEvent(event, event.agentId)) {
    const childName =
      event.metadata && typeof event.metadata === "object" && "childServiceName" in event.metadata
        ? String((event.metadata as Record<string, unknown>).childServiceName)
        : "unknown";
    beam = {
      active: true,
      type: beamTypeFromEventType(event.type),
      childServiceName: childName,
      sequence: event.sequence,
      createdAt: event.createdAt,
    };
  }

  return {
    ...state,
    [event.agentId]: {
      ...current,
      status: event.status ?? current.status,
      message: event.message ?? event.title,
      x: destination.x,
      y: destination.y,
      facing: destination.x < current.x ? "left" : "right",
      lastEventSequence: event.sequence,
      visitingReturn: isVisit || isDeskDwell
        ? { ...OFFICE_AGENTS[event.agentId].idle }
        : undefined,
      beam,
    },
  };
}

function isVisitEvent(type: PayLabsOfficeEvent["type"]): boolean {
  return type === "creator.paid" || type === "treasury.retained";
}

function isDeskDwellEvent(event: PayLabsOfficeEvent, agentId: OfficeAgentId): boolean {
  if (agentId === "brain_planner") return false;
  if (agentId === "discovery_planner" || agentId === "payment_decision" || agentId === "settlement_memory") return false;
  return event.type === "agent.completed";
}

export function reduceReturnToIdle(state: OfficeState, agentId: OfficeAgentId): OfficeState {
  const current = state[agentId];
  if (!current?.visitingReturn) return state;
  return {
    ...state,
    [agentId]: {
      ...current,
      status: "completed",
      x: current.visitingReturn.x,
      y: current.visitingReturn.y,
      facing: current.visitingReturn.x < current.x ? "left" : "right",
      visitingReturn: undefined,
    },
  };
}

/**
 * Clear a macro agent's beam state after its dwell timer fires.
 * Only clears when the expectedSequence matches — prevents stale timers
 * from clearing a newer beam.
 */
export function reduceClearMacroBeam(
  state: OfficeState,
  agentId: OfficeMacroAgentId,
  expectedSequence: number,
): OfficeState {
  const current = state[agentId];
  if (!current?.beam) return state;
  if (current.beam.sequence !== expectedSequence) return state;
  return {
    ...state,
    [agentId]: {
      ...current,
      status: "idle",
      beam: undefined,
    },
  };
}
