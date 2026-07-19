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
  if (event.type === "x402.requested" || event.type === "x402.settled") {
    return OFFICE_STATIONS.gateway;
  }
  if (event.type === "creator.paid") {
    return OFFICE_STATIONS.treasury;
  }
  if (event.status === "failed" || event.type === "run.failed" || event.type === "agent.failed") {
    return OFFICE_STATIONS.error;
  }
  if (event.status === "completed" || event.type === "run.completed") {
    return OFFICE_AGENTS[agentId].idle;
  }
  return OFFICE_AGENTS[agentId].desk;
}

export function reduceOfficeEvent(state: OfficeState, event: PayLabsOfficeEvent): OfficeState {
  if (!event.agentId) return state;
  const current = state[event.agentId];
  if (!current) return state;
  if (event.sequence <= current.lastEventSequence) return state;
  const destination = destinationFor(event, event.agentId);
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
    },
  };
}
