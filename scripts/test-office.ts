import assert from "node:assert/strict";
import { createInitialOfficeState, reduceOfficeEvent } from "../lib/paylabs/office/reducer";
import { OFFICE_AGENTS, OFFICE_STATIONS, assertOfficeRegistryMatchesServiceRegistry, officeAgentIdFromServiceName } from "../lib/paylabs/office/registry";
import { phaseFromMacroNode, statusFromServiceName, isOfficeServiceName } from "../lib/paylabs/office/event-mapper";
import type { PayLabsOfficeEvent } from "../lib/paylabs/office/types";

function event(partial: Partial<PayLabsOfficeEvent>): PayLabsOfficeEvent {
  return {
    id: partial.id ?? `evt-${partial.sequence ?? 1}`,
    runId: partial.runId ?? "test-run",
    sequence: partial.sequence ?? 1,
    type: partial.type ?? "agent.started",
    agentId: partial.agentId,
    phase: partial.phase,
    status: partial.status,
    title: partial.title ?? "test event",
    message: partial.message ?? null,
    payment: partial.payment ?? null,
    metadata: partial.metadata ?? null,
    createdAt: partial.createdAt ?? new Date(0).toISOString(),
  };
}

assertOfficeRegistryMatchesServiceRegistry();
assert.equal(officeAgentIdFromServiceName("signal_scout_basics"), "signal_scout_basics");
assert.equal(isOfficeServiceName("signal_scout_basics"), true);
assert.equal(isOfficeServiceName("signal_scout_basic"), false);

const childAgentIdleSpots = Object.values(OFFICE_AGENTS).filter((agent) => agent.id !== "brain_planner").map((agent) => `${agent.id}:${agent.idle.x},${agent.idle.y}`);
const uniqueChildIdleCoordinates = new Set(
  Object.values(OFFICE_AGENTS)
    .filter((agent) => agent.id !== "brain_planner")
    .map((agent) => `${agent.idle.x},${agent.idle.y}`),
);
assert.equal(uniqueChildIdleCoordinates.size, childAgentIdleSpots.length, "child agents have unique Lounge idle positions");
for (const agent of Object.values(OFFICE_AGENTS)) {
  if (agent.id === "brain_planner") continue;
  assert.equal(agent.idle.x >= 0 && agent.idle.x <= 354, true, `${agent.id} idle x stays inside Lounge`);
  assert.equal(agent.idle.y >= 318 && agent.idle.y <= 385, true, `${agent.id} idle y stays inside Lounge`);
}

let state = createInitialOfficeState();
for (const agent of Object.values(OFFICE_AGENTS)) {
  assert.deepEqual(
    { x: state[agent.id].x, y: state[agent.id].y },
    agent.idle,
    `${agent.id} initial state starts at idle position`,
  );
}
state = reduceOfficeEvent(state, event({ sequence: 1, agentId: "query_builder", status: "planning" }));
assert.deepEqual(
  { x: state.query_builder.x, y: state.query_builder.y },
  OFFICE_AGENTS.query_builder.desk,
  "agent goes to desk on start",
);

state = reduceOfficeEvent(state, event({ sequence: 2, agentId: "payment_decider", type: "x402.settled", status: "paying" }));
assert.deepEqual(
  { x: state.payment_decider.x, y: state.payment_decider.y },
  OFFICE_STATIONS.gateway,
  "x402.settled sends agent to Gateway",
);

state = reduceOfficeEvent(state, event({ sequence: 3, agentId: "creator_payout_router", type: "creator.paid", status: "completed" }));
assert.deepEqual(
  { x: state.creator_payout_router.x, y: state.creator_payout_router.y },
  OFFICE_STATIONS.creatorPayout,
  "creator.paid sends payout router to Creator Payout station",
);
state = reduceOfficeEvent(state, event({ sequence: 4, agentId: "creator_payout_router", type: "treasury.retained", status: "completed" }));
assert.deepEqual(
  { x: state.creator_payout_router.x, y: state.creator_payout_router.y },
  OFFICE_STATIONS.treasuryReserve,
  "treasury.retained sends payout router to Treasury Reserve station",
);

state = reduceOfficeEvent(state, event({ sequence: 4, agentId: "source_verifier", type: "agent.failed", status: "failed" }));
assert.deepEqual(
  { x: state.source_verifier.x, y: state.source_verifier.y },
  OFFICE_STATIONS.error,
  "failed agent goes to error zone",
);

state = reduceOfficeEvent(state, event({ sequence: 5, agentId: "query_builder", type: "agent.completed", status: "completed" }));
assert.deepEqual(
  { x: state.query_builder.x, y: state.query_builder.y },
  OFFICE_AGENTS.query_builder.idle,
  "completed agent returns idle",
);

state = reduceOfficeEvent(state, event({ sequence: 6, agentId: "intent_matcher", type: "agent.completed" }));
assert.deepEqual(
  { x: state.intent_matcher.x, y: state.intent_matcher.y },
  OFFICE_AGENTS.intent_matcher.idle,
  "agent.completed without status returns child agent to its assigned Lounge idle spot",
);

state = reduceOfficeEvent(state, event({ sequence: 7, agentId: "brain_planner", type: "agent.started", status: "planning" }));
assert.equal(state.brain_planner.status, "planning", "brain starts planning");
assert.deepEqual(
  { x: state.brain_planner.x, y: state.brain_planner.y },
  OFFICE_AGENTS.brain_planner.desk,
  "brain starts and stays at marked Control spot",
);
state = reduceOfficeEvent(state, event({ sequence: 8, agentId: "brain_planner", type: "x402.settled", status: "paying" }));
assert.deepEqual(
  { x: state.brain_planner.x, y: state.brain_planner.y },
  OFFICE_AGENTS.brain_planner.desk,
  "brain ignores gateway movement and stays at marked Control spot",
);
state = reduceOfficeEvent(state, event({ sequence: 9, agentId: "brain_planner", type: "agent.completed", status: "completed" }));
assert.equal(state.brain_planner.status, "completed", "brain completed event closes planning state");
assert.deepEqual(
  { x: state.brain_planner.x, y: state.brain_planner.y },
  OFFICE_AGENTS.brain_planner.desk,
  "brain completed state stays at marked Control spot",
);
state = reduceOfficeEvent(state, event({ sequence: 10, agentId: "brain_planner", type: "agent.failed", status: "failed" }));
assert.equal(state.brain_planner.status, "failed", "brain failed event closes planning state");
assert.deepEqual(
  { x: state.brain_planner.x, y: state.brain_planner.y },
  OFFICE_AGENTS.brain_planner.desk,
  "brain failed state stays at marked Control spot",
);

const beforeDuplicate = state.query_builder;
state = reduceOfficeEvent(state, event({ sequence: 4, agentId: "query_builder", type: "agent.started", status: "searching" }));
assert.deepEqual(state.query_builder, beforeDuplicate, "out-of-order sequence ignored");
state = reduceOfficeEvent(state, event({ sequence: 5, agentId: "query_builder", type: "agent.started", status: "searching" }));
assert.deepEqual(state.query_builder, beforeDuplicate, "duplicate sequence ignored");

assert.equal(statusFromServiceName("signal_scout_basics"), "searching");
assert.equal(statusFromServiceName("intent_matcher"), "verifying");
assert.equal(statusFromServiceName("source_verifier"), "verifying");
assert.equal(statusFromServiceName("value_allocator"), "calculating");
assert.equal(statusFromServiceName("creator_payout_router"), "settling");
assert.equal(phaseFromMacroNode("payment_decision"), "payment_decision");
assert.equal(phaseFromMacroNode("unknown"), "brain");

console.log("PayLabs office tests passed");
