import { OFFICE_AGENTS, OFFICE_STATIONS } from "./registry";
import type { OfficeAgentId, OfficeAgentViewState, PayLabsOfficeEvent } from "./types";

export type OfficeState = Record<OfficeAgentId, OfficeAgentViewState>;

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

export function reduceOfficeEvent(state: OfficeState, event: PayLabsOfficeEvent): OfficeState {
  if (!event.agentId) return state;
  const current = state[event.agentId];
  if (!current) return state;
  if (event.sequence <= current.lastEventSequence) return state;
  const destination = destinationFor(event, event.agentId);
  const isVisit = isVisitEvent(event.type);
  const isDeskDwell = !isVisit && isDeskDwellEvent(event, event.agentId);
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
    },
  };
}

function isVisitEvent(type: PayLabsOfficeEvent["type"]): boolean {
  return type === "creator.paid" || type === "treasury.retained";
}

function isDeskDwellEvent(event: PayLabsOfficeEvent, agentId: OfficeAgentId): boolean {
  if (agentId === "brain_planner") return false;
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
