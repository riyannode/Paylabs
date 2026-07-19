import assert from "node:assert/strict";
import { createInitialOfficeState, reduceOfficeEvent, reduceReturnToIdle } from "../lib/paylabs/office/reducer";
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

// ── Test 7: all desk coordinates are unique ────────────────────────
const allDeskCoords = Object.values(OFFICE_AGENTS).map((a) => `${a.desk.x},${a.desk.y}`);
assert.equal(new Set(allDeskCoords).size, allDeskCoords.length, "all desk coordinates are unique");

// ── Test 8: all idle coordinates are unique ────────────────────────
const childAgents = Object.values(OFFICE_AGENTS).filter((a) => a.id !== "brain_planner");
const childIdleCoords = childAgents.map((a) => `${a.idle.x},${a.idle.y}`);
assert.equal(new Set(childIdleCoords).size, childIdleCoords.length, "child agents have unique Lounge idle positions");

// ── Test 9: all coordinates inside correct zones ───────────────────
const CANVAS = { width: 900, height: 430 };
const AGENT_SPRITE = { width: 36, height: 61 };
const LOUNGE_BOUNDS = { left: 0, right: 390, top: 318, bottom: 430 };

const DISCOVERY_BOUNDS = { left: 0, right: 280, top: 64, bottom: 318 };
const PAYMENT_BOUNDS = { left: 280, right: 610, top: 0, bottom: 318 };
const SETTLEMENT_BOUNDS = { left: 610, right: 900, top: 0, bottom: 318 };
const CONTROL_BOUNDS = { left: 0, right: 280, top: 0, bottom: 318 };

const ZONE_MAP: Record<string, { left: number; right: number; top: number; bottom: number }> = {
  executive: CONTROL_BOUNDS,
  discovery: DISCOVERY_BOUNDS,
  payment: PAYMENT_BOUNDS,
  settlement: SETTLEMENT_BOUNDS,
};

for (const agent of Object.values(OFFICE_AGENTS)) {
  const zone = ZONE_MAP[agent.department];
  assert.ok(agent.desk.x >= zone.left && agent.desk.x + AGENT_SPRITE.width <= zone.right,
    `${agent.id} desk x inside ${agent.department} zone`);
  assert.ok(agent.desk.y >= zone.top && agent.desk.y + AGENT_SPRITE.height <= zone.bottom,
    `${agent.id} desk y inside ${agent.department} zone`);
}

for (const agent of childAgents) {
  assert.equal(agent.idle.x >= LOUNGE_BOUNDS.left, true, `${agent.id} idle x inside Lounge left`);
  assert.equal(agent.idle.x + AGENT_SPRITE.width <= LOUNGE_BOUNDS.right, true, `${agent.id} idle x inside Lounge right`);
  assert.equal(agent.idle.y >= LOUNGE_BOUNDS.top, true, `${agent.id} idle y inside Lounge top`);
  assert.equal(agent.idle.y + AGENT_SPRITE.height <= LOUNGE_BOUNDS.bottom, true, `${agent.id} idle y inside Lounge bottom`);
}

for (const [name, pos] of Object.entries(OFFICE_STATIONS)) {
  assert.ok(pos.x >= 0 && pos.x + AGENT_SPRITE.width <= CANVAS.width,
    `station ${name} x inside canvas`);
  assert.ok(pos.y >= 0 && pos.y + AGENT_SPRITE.height <= CANVAS.height,
    `station ${name} y inside canvas`);
}

// ── initial state ──────────────────────────────────────────────────
let state = createInitialOfficeState();
for (const agent of Object.values(OFFICE_AGENTS)) {
  assert.deepEqual(
    { x: state[agent.id].x, y: state[agent.id].y },
    agent.idle,
    `${agent.id} initial state starts at idle position`,
  );
}

// ── basic agent desk movement ──────────────────────────────────────
state = reduceOfficeEvent(state, event({ sequence: 1, agentId: "query_builder", status: "planning" }));
assert.deepEqual(
  { x: state.query_builder.x, y: state.query_builder.y },
  OFFICE_AGENTS.query_builder.desk,
  "agent goes to desk on start",
);

// ── x402 settlement moves to gateway ──────────────────────────────
state = reduceOfficeEvent(state, event({ sequence: 2, agentId: "payment_decider", type: "x402.settled", status: "paying" }));
assert.deepEqual(
  { x: state.payment_decider.x, y: state.payment_decider.y },
  OFFICE_STATIONS.gateway,
  "x402.settled sends agent to Gateway",
);

// ── Test 1: creator.paid moves router to Creator Payout ───────────
state = reduceOfficeEvent(state, event({ sequence: 3, agentId: "creator_payout_router", type: "creator.paid", status: "settling" }));
assert.deepEqual(
  { x: state.creator_payout_router.x, y: state.creator_payout_router.y },
  OFFICE_STATIONS.creatorPayout,
  "creator.paid sends payout router to Creator Payout station",
);
assert.ok(state.creator_payout_router.visitingReturn, "creator.paid sets visitingReturn");
assert.deepEqual(
  state.creator_payout_router.visitingReturn,
  OFFICE_AGENTS.creator_payout_router.idle,
  "visitingReturn targets the router's configured idle position",
);

// ── Test 2: treasury.retained moves router to Treasury Reserve ─────
state = reduceOfficeEvent(state, event({ sequence: 4, agentId: "creator_payout_router", type: "treasury.retained", status: "settling" }));
assert.deepEqual(
  { x: state.creator_payout_router.x, y: state.creator_payout_router.y },
  OFFICE_STATIONS.treasuryReserve,
  "treasury.retained sends payout router to Treasury Reserve station",
);
assert.ok(state.creator_payout_router.visitingReturn, "treasury.retained sets visitingReturn");

// ── Test 3: reduceReturnToIdle returns router to configured idle ───
state = reduceReturnToIdle(state, "creator_payout_router");
assert.deepEqual(
  { x: state.creator_payout_router.x, y: state.creator_payout_router.y },
  OFFICE_AGENTS.creator_payout_router.idle,
  "after dwell, router returns to its configured Lounge idle position",
);
assert.equal(state.creator_payout_router.visitingReturn, undefined, "visitingReturn cleared after return");
assert.equal(state.creator_payout_router.status, "completed", "status set to completed after return");

// ── Test 4: newer event cancels pending Lounge return ──────────────
state = reduceOfficeEvent(state, event({ sequence: 10, agentId: "creator_payout_router", type: "creator.paid", status: "settling" }));
assert.ok(state.creator_payout_router.visitingReturn, "visitingReturn set after creator.paid");
// Now fire a newer event that is NOT a visit event
state = reduceOfficeEvent(state, event({ sequence: 11, agentId: "creator_payout_router", type: "agent.started", status: "planning" }));
assert.equal(state.creator_payout_router.visitingReturn, undefined, "newer event clears visitingReturn");
assert.deepEqual(
  { x: state.creator_payout_router.x, y: state.creator_payout_router.y },
  OFFICE_AGENTS.creator_payout_router.desk,
  "newer event moves router to desk",
);
// reduceReturnToIdle should be a no-op now
const beforeReturn = { ...state.creator_payout_router };
state = reduceReturnToIdle(state, "creator_payout_router");
assert.deepEqual(state.creator_payout_router, beforeReturn, "reduceReturnToIdle is no-op when visitingReturn is cleared");

// ── Test 5: agent.failed overrides to error station ────────────────
state = reduceOfficeEvent(state, event({ sequence: 12, agentId: "creator_payout_router", type: "creator.paid", status: "settling" }));
assert.ok(state.creator_payout_router.visitingReturn, "visitingReturn set before failure");
state = reduceOfficeEvent(state, event({ sequence: 13, agentId: "creator_payout_router", type: "agent.failed", status: "failed" }));
assert.deepEqual(
  { x: state.creator_payout_router.x, y: state.creator_payout_router.y },
  OFFICE_STATIONS.error,
  "agent.failed sends router to error station",
);
assert.equal(state.creator_payout_router.visitingReturn, undefined, "agent.failed clears visitingReturn");
assert.equal(state.creator_payout_router.status, "failed", "status set to failed");

// ── error station for other agents ─────────────────────────────────
state = reduceOfficeEvent(state, event({ sequence: 14, agentId: "source_verifier", type: "agent.failed", status: "failed" }));
assert.deepEqual(
  { x: state.source_verifier.x, y: state.source_verifier.y },
  OFFICE_STATIONS.error,
  "failed agent goes to error zone",
);

// ── Test 6: ordinary agents return to idle after completion ────────
state = reduceOfficeEvent(state, event({ sequence: 15, agentId: "query_builder", type: "agent.completed", status: "completed" }));
assert.deepEqual(
  { x: state.query_builder.x, y: state.query_builder.y },
  OFFICE_AGENTS.query_builder.idle,
  "completed agent returns idle",
);

state = reduceOfficeEvent(state, event({ sequence: 16, agentId: "intent_matcher", type: "agent.completed" }));
assert.deepEqual(
  { x: state.intent_matcher.x, y: state.intent_matcher.y },
  OFFICE_AGENTS.intent_matcher.idle,
  "agent.completed without status returns child agent to its assigned Lounge idle spot",
);

// ── brain planner always stays at desk ─────────────────────────────
state = reduceOfficeEvent(state, event({ sequence: 20, agentId: "brain_planner", type: "agent.started", status: "planning" }));
assert.equal(state.brain_planner.status, "planning", "brain starts planning");
assert.deepEqual(
  { x: state.brain_planner.x, y: state.brain_planner.y },
  OFFICE_AGENTS.brain_planner.desk,
  "brain starts and stays at marked Control spot",
);
state = reduceOfficeEvent(state, event({ sequence: 21, agentId: "brain_planner", type: "x402.settled", status: "paying" }));
assert.deepEqual(
  { x: state.brain_planner.x, y: state.brain_planner.y },
  OFFICE_AGENTS.brain_planner.desk,
  "brain ignores gateway movement and stays at marked Control spot",
);
state = reduceOfficeEvent(state, event({ sequence: 22, agentId: "brain_planner", type: "agent.completed", status: "completed" }));
assert.equal(state.brain_planner.status, "completed", "brain completed event closes planning state");
assert.deepEqual(
  { x: state.brain_planner.x, y: state.brain_planner.y },
  OFFICE_AGENTS.brain_planner.desk,
  "brain completed state stays at marked Control spot",
);
state = reduceOfficeEvent(state, event({ sequence: 23, agentId: "brain_planner", type: "agent.failed", status: "failed" }));
assert.equal(state.brain_planner.status, "failed", "brain failed event closes planning state");
assert.deepEqual(
  { x: state.brain_planner.x, y: state.brain_planner.y },
  OFFICE_AGENTS.brain_planner.desk,
  "brain failed state stays at marked Control spot",
);

// ── duplicate / out-of-order sequence ignored ──────────────────────
const beforeDuplicate = { ...state.query_builder };
state = reduceOfficeEvent(state, event({ sequence: 4, agentId: "query_builder", type: "agent.started", status: "searching" }));
assert.deepEqual(state.query_builder, beforeDuplicate, "out-of-order sequence ignored");
state = reduceOfficeEvent(state, event({ sequence: 5, agentId: "query_builder", type: "agent.started", status: "searching" }));
assert.deepEqual(state.query_builder, beforeDuplicate, "duplicate sequence ignored");

// ── event-mapper helpers ───────────────────────────────────────────
assert.equal(statusFromServiceName("signal_scout_basics"), "searching");
assert.equal(statusFromServiceName("intent_matcher"), "verifying");
assert.equal(statusFromServiceName("source_verifier"), "verifying");
assert.equal(statusFromServiceName("value_allocator"), "calculating");
assert.equal(statusFromServiceName("creator_payout_router"), "settling");
assert.equal(phaseFromMacroNode("payment_decision"), "payment_decision");
assert.equal(phaseFromMacroNode("unknown"), "brain");

// ── UI presentation tests ─────────────────────────────────────────

// Test: agent settlement rows render agent name and status
const settlementState = createInitialOfficeState();
const settledAgents = ["creator_payout_router", "creator_attribution", "payment_decider", "trust_verifier"] as const;
let s = settlementState;
for (const agentId of settledAgents) {
  s = reduceOfficeEvent(s, event({ sequence: 100 + settledAgents.indexOf(agentId), agentId, type: "agent.completed", status: "completed" }));
}
for (const agentId of settledAgents) {
  assert.equal(s[agentId].status, "completed", `${agentId} settlement row shows completed status`);
}

// Test: events still carry payment.amountUsdc for Receipt (data layer preserved)
const paymentEvent = event({
  sequence: 200,
  agentId: "payment_decider",
  type: "x402.settled",
  status: "settling",
  payment: { amountUsdc: "0.000001", status: "settled", txHash: "0xabc" },
});
assert.equal(paymentEvent.payment?.amountUsdc, "0.000001", "payment.amountUsdc preserved in event data for Receipt");
assert.equal(paymentEvent.payment?.status, "settled", "payment.status preserved in event data");

// Test: dashboard source no longer contains USDC/monetary rendering
import { readFileSync } from "node:fs";
const dashboardSource = readFileSync(
  new URL("../components/paylabs/office/PayLabsOfficeDashboard.tsx", import.meta.url),
  "utf-8",
);
assert.ok(!dashboardSource.includes("USDC"), "dashboard does not render USDC text");
assert.ok(!dashboardSource.includes("toFixed(6)"), "dashboard does not call toFixed(6) for amount formatting");
assert.ok(!dashboardSource.includes("amountUsdc"), "dashboard does not reference amountUsdc");
assert.ok(!dashboardSource.includes("Planned"), "dashboard does not render Planned cost row");
assert.ok(!dashboardSource.includes("Office event total"), "dashboard does not render total USDC row");
assert.ok(!dashboardSource.includes("safeExplorerUrl"), "dashboard does not import payment-links helper");
assert.ok(!dashboardSource.includes("po-payment-list"), "dashboard does not render payment list rows");

// Test: agent directory still shows name + status
assert.ok(dashboardSource.includes("shortLabel"), "dashboard still renders agent shortLabel");
assert.ok(dashboardSource.includes("agent.status"), "dashboard still renders agent status");
assert.ok(dashboardSource.includes("po-agent-directory"), "dashboard still renders agent directory");
assert.ok(dashboardSource.includes("po-status-dot"), "dashboard still renders status dots");

// Test: aggregate counters still present
assert.ok(dashboardSource.includes("Settled edges"), "dashboard retains Settled edges counter");
assert.ok(dashboardSource.includes("Paid graph"), "dashboard retains Paid graph counter");
assert.ok(dashboardSource.includes("Receipt"), "dashboard retains Receipt status");

// Test: PixelAgent bubble shows message, not price
const agentSource = readFileSync(
  new URL("../components/paylabs/office/PixelAgent.tsx", import.meta.url),
  "utf-8",
);
assert.ok(!agentSource.includes("USDC"), "PixelAgent does not render USDC");
assert.ok(!agentSource.includes("amountUsdc"), "PixelAgent does not reference amountUsdc");
assert.ok(agentSource.includes("agent.message"), "PixelAgent still renders agent message");

// Test: AgentDetailPopover shows label + status only
const popoverSource = readFileSync(
  new URL("../components/paylabs/office/AgentDetailPopover.tsx", import.meta.url),
  "utf-8",
);
assert.ok(!popoverSource.includes("USDC"), "AgentDetailPopover does not render USDC");
assert.ok(!popoverSource.includes("amountUsdc"), "AgentDetailPopover does not reference amountUsdc");
assert.ok(!popoverSource.includes("price"), "AgentDetailPopover does not render price");
assert.ok(popoverSource.includes("definition.label"), "AgentDetailPopover shows agent label");
assert.ok(popoverSource.includes("agent.status"), "AgentDetailPopover shows agent status");

console.log("PayLabs office tests passed");
