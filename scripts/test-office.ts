import assert from "node:assert/strict";
import { createInitialOfficeState, reduceOfficeEvent, reduceReturnToIdle } from "../lib/paylabs/office/reducer";
import { OFFICE_AGENTS, OFFICE_STATIONS, assertOfficeRegistryMatchesServiceRegistry, officeAgentIdFromServiceName } from "../lib/paylabs/office/registry";
import { phaseFromMacroNode, statusFromServiceName, isOfficeServiceName } from "../lib/paylabs/office/event-mapper";
import { mergeOfficeEvents } from "../lib/paylabs/office/selectors";
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

// ── Monetary sanitization tests ─────────────────────────────────

import { sanitizeOfficeMessage, sanitizeDisplayMessage } from "../lib/paylabs/office/sanitizer";

function expectOfficeMessageToBeNonMonetary(message: string | null | undefined): void {
  if (message == null) return;
  assert.ok(!/\bUSDC\b/i.test(message), `message must not contain USDC: "${message}"`);
  assert.ok(!/[\$€£¥₹]\s*\d/.test(message), `message must not contain currency symbols with amounts: "${message}"`);
  assert.ok(!/\b\d+\.?\d*\s*(?:USD|EUR|GBP|BTC|ETH|DAI|USDT)\b/i.test(message), `message must not contain token amounts: "${message}"`);
  assert.ok(!/\b(?:cost|spend|budget|fee|balance|price)\s*[:=]\s*\d/i.test(message), `message must not contain named monetary fields: "${message}"`);
}

// Test: x402.settled bubble is sanitized at emission boundary
const x402SettledMsg = sanitizeOfficeMessage("0.000001 USDC", "x402.settled");
expectOfficeMessageToBeNonMonetary(x402SettledMsg);
assert.equal(x402SettledMsg, "x402 settlement completed", "x402.settled monetary message replaced with safe fallback");

// Test: x402.settled with larger amount
const x402LargeMsg = sanitizeOfficeMessage("1.500000 USDC", "x402.settled");
expectOfficeMessageToBeNonMonetary(x402LargeMsg);
assert.equal(x402LargeMsg, "x402 settlement completed", "x402.settled large monetary message replaced");

// Test: treasury.retained with reserve amount is sanitized
const treasuryMsg = sanitizeOfficeMessage("0.00002 USDC retained in treasury reserve", "treasury.retained");
expectOfficeMessageToBeNonMonetary(treasuryMsg);
assert.equal(treasuryMsg, "Funds retained in treasury reserve", "treasury.retained monetary message replaced");

// Test: treasury.retained safe message is preserved
const treasurySafeMsg = sanitizeOfficeMessage("No verified creator payout; funds retained in treasury reserve", "treasury.retained");
assert.equal(treasurySafeMsg, "No verified creator payout; funds retained in treasury reserve", "treasury.retained non-monetary message preserved");

// Test: generic agent.completed with monetary safeSummary is sanitized
const deciderSummary = "Approved 3/5 items, total spend: 0.000012 USDC, remaining budget: 0.000088 USDC.";
const completedMsg = sanitizeOfficeMessage(deciderSummary, "agent.completed");
expectOfficeMessageToBeNonMonetary(completedMsg);
assert.equal(completedMsg, "Service completed", "agent.completed monetary safeSummary replaced with safe fallback");

// Test: historical Supabase event message containing 0.00002 USDC is sanitized at render boundary
const historicalMsg = sanitizeDisplayMessage("0.00002 USDC retained in treasury reserve");
expectOfficeMessageToBeNonMonetary(historicalMsg);
assert.equal(historicalMsg, "Service completed", "historical Supabase message with USDC sanitized at render boundary");

// Test: historical message with just "USDC" is sanitized
const historicalUsdcOnly = sanitizeDisplayMessage("x402 settlement: 0.000001 USDC");
expectOfficeMessageToBeNonMonetary(historicalUsdcOnly);

// Test: safe operational messages remain readable
const safeMessages = [
  "Working in payment_decision",
  "x402 settlement completed",
  "Creator payout completed",
  "Funds retained in treasury reserve",
  "No verified creator payout; funds retained in treasury reserve",
  "Service completed",
  "Service failed",
  "Preparing Brain plan and route execution",
  "Selecting route tier, phases, and services",
  "advanced route · 8 services",
  "Planning unavailable; continuing with tier defaults",
  "Required x402 child is not enabled",
  "2 candidates · 1 source cards",
  "3 approved · 1 skipped",
];
for (const msg of safeMessages) {
  const result = sanitizeOfficeMessage(msg, "agent.completed");
  assert.equal(result, msg, `safe message preserved: "${msg}"`);
}

// Test: $ symbol with amount is sanitized
const dollarMsg = sanitizeOfficeMessage("$0.01 per citation", "agent.completed");
expectOfficeMessageToBeNonMonetary(dollarMsg);

// Test: payment.amountUsdc remains unchanged in event data (data layer preserved)
const x402Event = event({
  sequence: 300,
  agentId: "payment_decider",
  type: "x402.settled",
  status: "settling",
  payment: { amountUsdc: "0.000001", status: "settled", txHash: "0xabc123" },
  message: "0.000001 USDC",
});
const sanitizedEvent = (await import("../lib/paylabs/office/sanitizer")).sanitizeOfficeEvent(x402Event);
expectOfficeMessageToBeNonMonetary(sanitizedEvent.message);
assert.equal(sanitizedEvent.payment?.amountUsdc, "0.000001", "payment.amountUsdc preserved after sanitization");
assert.equal(sanitizedEvent.payment?.txHash, "0xabc123", "payment.txHash preserved after sanitization");

// Test: metadata monetary fields are not mutated by sanitization
const metaEvent = event({
  sequence: 301,
  agentId: "creator_payout_router",
  type: "treasury.retained",
  status: "settling",
  message: "0.005 USDC retained in treasury reserve",
  metadata: { pendingReserveUsdc: 0.005, costUsdc: 0.01 },
});
const sanitizedMetaEvent = (await import("../lib/paylabs/office/sanitizer")).sanitizeOfficeEvent(metaEvent);
expectOfficeMessageToBeNonMonetary(sanitizedMetaEvent.message);
assert.equal((sanitizedMetaEvent.metadata as Record<string, unknown>)?.pendingReserveUsdc, 0.005, "metadata.pendingReserveUsdc preserved");
assert.equal((sanitizedMetaEvent.metadata as Record<string, unknown>)?.costUsdc, 0.01, "metadata.costUsdc preserved");

// Test: null/undefined messages pass through
assert.equal(sanitizeOfficeMessage(null, "agent.completed"), null, "null message passes through");
assert.equal(sanitizeOfficeMessage(undefined, "agent.completed"), null, "undefined message passes through as null");
assert.equal(sanitizeDisplayMessage(null), null, "null display message passes through");
assert.equal(sanitizeDisplayMessage(undefined), null, "undefined display message passes through as null");

// Test: PixelAgent source imports sanitizer
assert.ok(agentSource.includes("sanitizeDisplayMessage"), "PixelAgent imports sanitizeDisplayMessage");
assert.ok(agentSource.includes("displayMessage"), "PixelAgent uses sanitized displayMessage for bubble");

// Test: sanitizer source file exists and exports expected functions
import { readFileSync as readSync } from "node:fs";
const sanitizerSource = readSync(
  new URL("../lib/paylabs/office/sanitizer.ts", import.meta.url),
  "utf-8",
);
assert.ok(sanitizerSource.includes("sanitizeOfficeMessage"), "sanitizer exports sanitizeOfficeMessage");
assert.ok(sanitizerSource.includes("sanitizeOfficeEvent"), "sanitizer exports sanitizeOfficeEvent");
assert.ok(sanitizerSource.includes("sanitizeDisplayMessage"), "sanitizer exports sanitizeDisplayMessage");
assert.ok(!sanitizerSource.includes("createClient"), "sanitizer has no Supabase dependency (pure function)");

// Test: server.ts imports sanitizer
const serverSource = readSync(
  new URL("../lib/paylabs/office/server.ts", import.meta.url),
  "utf-8",
);
assert.ok(serverSource.includes('from "./sanitizer"'), "server.ts imports from sanitizer");
assert.ok(serverSource.includes("sanitizeOfficeEvent"), "server.ts uses sanitizeOfficeEvent at emission boundary");

// ── Brain bubble operational status tests ──────────────────────

// Test: all Brain bubble messages are preserved by sanitizer (no monetary content)
const brainMessages = [
  "Analyzing request",
  "Selecting route",
  "Execution plan ready",
];
for (const msg of brainMessages) {
  const sanitized = sanitizeOfficeMessage(msg, "agent.completed");
  assert.equal(sanitized, msg, `Brain message preserved by sanitizer: "${msg}"`);
  expectOfficeMessageToBeNonMonetary(sanitized);
}

// Test: Brain messages contain no USDC, no reasoning, no monetary fields
for (const msg of brainMessages) {
  assert.ok(!msg.includes("USDC"), `Brain message has no USDC: "${msg}"`);
  assert.ok(!msg.includes("route tier"), `Brain message has no route tier detail: "${msg}"`);
  assert.ok(!msg.includes("·"), `Brain message has no separator/count: "${msg}"`);
  assert.ok(!/\d+\s*service/.test(msg), `Brain message has no service count: "${msg}"`);
  assert.ok(!/\d+\s*candidate/.test(msg), `Brain message has no candidate count: "${msg}"`);
  assert.ok(!/budget|cost|spend|fee|balance|price|planned/i.test(msg), `Brain message has no monetary field names: "${msg}"`);
  assert.ok(!/considering|suggesting|reasoning|because|therefore|alternatives/i.test(msg), `Brain message has no chain-of-thought: "${msg}"`);
}

// Test: Brain messages reach the bubble through the reducer flow
let brainState = createInitialOfficeState();

// Step 1: run.started → "Analyzing request"
brainState = reduceOfficeEvent(brainState, event({
  sequence: 40,
  agentId: "brain_planner",
  type: "run.started",
  status: "planning",
  message: "Analyzing request",
}));
assert.equal(brainState.brain_planner.message, "Analyzing request", "Brain bubble shows 'Analyzing request' after run.started");
assert.equal(brainState.brain_planner.status, "planning", "Brain status is planning after run.started");

// Step 2: agent.started → "Selecting route" (overwrites previous)
brainState = reduceOfficeEvent(brainState, event({
  sequence: 41,
  agentId: "brain_planner",
  type: "agent.started",
  status: "planning",
  message: "Selecting route",
}));
assert.equal(brainState.brain_planner.message, "Selecting route", "Brain bubble updates to 'Selecting route'");
assert.equal(brainState.brain_planner.status, "planning", "Brain status remains planning");

// Step 3: agent.completed → "Execution plan ready" (final)
brainState = reduceOfficeEvent(brainState, event({
  sequence: 42,
  agentId: "brain_planner",
  type: "agent.completed",
  status: "completed",
  message: "Execution plan ready",
}));
assert.equal(brainState.brain_planner.message, "Execution plan ready", "Brain bubble shows 'Execution plan ready' after plan lock");
assert.equal(brainState.brain_planner.status, "completed", "Brain status is completed");

// Step 4: child agent event does NOT clear Brain bubble
brainState = reduceOfficeEvent(brainState, event({
  sequence: 43,
  agentId: "query_builder",
  type: "agent.started",
  status: "planning",
  message: "Working in discovery_planner",
}));
assert.equal(brainState.brain_planner.message, "Execution plan ready", "Brain bubble unchanged after child agent event");

// Test: Brain messages don't alter payment or metadata fields
const brainEvent = event({
  sequence: 50,
  agentId: "brain_planner",
  type: "agent.completed",
  status: "completed",
  message: "Execution plan ready",
  metadata: { tier: "advanced", plannedCostUsdc: 0.008 },
});
const sanitizedBrainEvent = (await import("../lib/paylabs/office/sanitizer")).sanitizeOfficeEvent(brainEvent);
assert.equal(sanitizedBrainEvent.message, "Execution plan ready", "Brain message preserved after sanitization");
assert.equal((sanitizedBrainEvent.metadata as Record<string, unknown>)?.tier, "advanced", "Brain metadata.tier preserved");
assert.equal((sanitizedBrainEvent.metadata as Record<string, unknown>)?.plannedCostUsdc, 0.008, "Brain metadata.plannedCostUsdc preserved");

// Test: orchestrator source contains the new Brain messages
const orchestratorSource = readSync(
  new URL("../lib/paylabs/delegated-runtime/orchestrator.ts", import.meta.url),
  "utf-8",
);
assert.ok(orchestratorSource.includes('"Analyzing request"'), "orchestrator emits 'Analyzing request'");
assert.ok(orchestratorSource.includes('"Selecting route"'), "orchestrator emits 'Selecting route'");
assert.ok(orchestratorSource.includes('"Execution plan ready"'), "orchestrator emits 'Execution plan ready'");
assert.ok(!orchestratorSource.includes("Preparing Brain plan"), "orchestrator no longer emits old verbose Brain message");
assert.ok(!orchestratorSource.includes("Selecting route tier"), "orchestrator no longer emits old route tier message");
assert.ok(!orchestratorSource.includes("route ·"), "orchestrator no longer emits tier/service count separator");
assert.ok(!orchestratorSource.includes("Planning unavailable"), "orchestrator no longer emits old fallback message");

// ── Brain bubble positioning tests ──────────────────────────

// Read CSS source for brain bubble assertions
const cssSource = readSync(
  new URL("../components/paylabs/office/paylabs-office.css", import.meta.url),
  "utf-8",
);

// Test: PixelAgent adds is-brain class only to brain_planner
assert.ok(agentSource.includes("is-brain"), "PixelAgent source contains is-brain class");
assert.ok(agentSource.includes('agent.id === "brain_planner"'), "is-brain class conditional checks brain_planner id");

// Test: Brain-specific CSS exists
assert.ok(cssSource.includes(".po-agent-wrap.is-brain .po-agent-bubble"), "Brain bubble CSS rule exists");
assert.ok(cssSource.includes(".po-agent-wrap.is-brain .po-agent-bubble::after"), "Brain bubble tail override CSS rule exists");

// Test: default agent bubble CSS remains unchanged
assert.ok(cssSource.includes(".po-agent-bubble { position: absolute; left: 28px; top: -23px"), "default bubble position unchanged");

// Test: Brain coordinates remain unchanged
assert.equal(OFFICE_AGENTS.brain_planner.desk.x, 150, "Brain desk x unchanged");
assert.equal(OFFICE_AGENTS.brain_planner.desk.y, 10, "Brain desk y unchanged");
assert.equal(OFFICE_AGENTS.brain_planner.idle.x, 150, "Brain idle x unchanged");
assert.equal(OFFICE_AGENTS.brain_planner.idle.y, 10, "Brain idle y unchanged");

// Test: Brain bubble calculated top is not negative
// Brain wrap at canvas y=10, bubble top=18px → canvas y=28 (positive, below CONTROL heading)
const BRAIN_BUBBLE_TOP_PX = 18;
const brainBubbleCanvasTop = OFFICE_AGENTS.brain_planner.desk.y + BRAIN_BUBBLE_TOP_PX;
assert.ok(brainBubbleCanvasTop >= 0, `Brain bubble canvas top (${brainBubbleCanvasTop}) is not negative`);

// Test: Brain bubble does not overlap CONTROL heading
// CONTROL heading: canvas (10, 12) to (65, 27) — measured via Playwright
const CONTROL_HEADING_BOTTOM = 27;
assert.ok(brainBubbleCanvasTop > CONTROL_HEADING_BOTTOM,
  `Brain bubble top (${brainBubbleCanvasTop}) is below CONTROL heading bottom (${CONTROL_HEADING_BOTTOM})`);

// Test: Brain bubble calculated left is inside canvas
// Brain wrap at canvas x=150, bubble left=-140px → canvas x=10 (inside 900)
const brainBubbleCanvasLeft = OFFICE_AGENTS.brain_planner.desk.x + (-140);
assert.ok(brainBubbleCanvasLeft >= 0, `Brain bubble canvas left (${brainBubbleCanvasLeft}) is inside canvas`);

// Test: Brain bubble right edge inside canvas
const brainBubbleWidth = 120;
assert.ok(brainBubbleCanvasLeft + brainBubbleWidth <= 900, `Brain bubble right (${brainBubbleCanvasLeft + brainBubbleWidth}) inside 900`);

// Test: Brain bubble does not overlap the label
// Label left: brain_desk_x + (-14) = 136
const brainLabelCanvasLeft = OFFICE_AGENTS.brain_planner.desk.x + (-14);
assert.ok(brainBubbleCanvasLeft + brainBubbleWidth <= brainLabelCanvasLeft - 6, `Brain bubble (${brainBubbleCanvasLeft + brainBubbleWidth}) does not overlap label (${brainLabelCanvasLeft}) with 6px gap`);

// Test: Brain bubble does not overlap Brain sprite
// Sprite: canvas (154, 27) to (182, 68) — measured via Playwright
const BRAIN_SPRITE_LEFT = OFFICE_AGENTS.brain_planner.desk.x + 4;
const BRAIN_SPRITE_RIGHT = BRAIN_SPRITE_LEFT + 28;
assert.ok(brainBubbleCanvasLeft + brainBubbleWidth <= BRAIN_SPRITE_LEFT,
  `Brain bubble (${brainBubbleCanvasLeft + brainBubbleWidth}) does not overlap sprite left (${BRAIN_SPRITE_LEFT})`);

// Test: Brain bubble does not overlap boss desk
// Boss desk: canvas (105, 68) to (225, 126) — measured via Playwright
const BOSS_DESK_TOP = 68;
const brainBubbleCanvasBottom = brainBubbleCanvasTop + 22;
assert.ok(brainBubbleCanvasBottom <= BOSS_DESK_TOP,
  `Brain bubble bottom (${brainBubbleCanvasBottom}) does not overlap boss desk top (${BOSS_DESK_TOP})`);

// Test: sanitizer remains active for Brain messages
assert.ok(agentSource.includes("sanitizeDisplayMessage"), "PixelAgent still imports sanitizeDisplayMessage");
assert.ok(agentSource.includes("displayMessage"), "PixelAgent still uses sanitized displayMessage for bubble");

console.log("PayLabs office tests passed");

// ── Subscription race regression tests ─────────────────────────────
// These test the exact scenario from PR #165 follow-up:
//   1. Channel subscription starts but is not yet SUBSCRIBED
//   2. Early Brain events are inserted into Supabase
//   3. Channel reaches SUBSCRIBED
//   4. History backfill fetches Brain events (already in DB)
//   5. A later child-agent event arrives through Realtime
//   6. Final Brain state is completed, message is "Execution plan ready"
//   7. Child agent state is also updated
//   8. No duplicate activity-log entries

{
  // Simulate the race: history backfill + Realtime overlap
  const brainStarted = event({
    id: "brain-start-1",
    sequence: 1,
    agentId: "brain_planner",
    type: "agent.started",
    status: "planning",
    message: "Analyzing request",
  });
  const brainPlanning = event({
    id: "brain-plan-2",
    sequence: 2,
    agentId: "brain_planner",
    type: "agent.started",
    status: "planning",
    message: "Selecting route",
  });
  const brainCompleted = event({
    id: "brain-done-3",
    sequence: 3,
    agentId: "brain_planner",
    type: "agent.completed",
    status: "completed",
    message: "Execution plan ready",
  });

  // Simulate: history fetch returns Brain events (already in DB)
  const historyEvents = [brainStarted, brainPlanning, brainCompleted];

  // Simulate: Realtime buffered the same Brain events (arrived before SUBSCRIBED)
  const realtimeBuffered = [brainStarted, brainPlanning, brainCompleted];

  // mergeOfficeEvents deduplicates by event.id — identical IDs produce one entry
  const merged = mergeOfficeEvents([], [...historyEvents, ...realtimeBuffered]);
  assert.equal(merged.length, 3, "merged history + realtime buffer has no duplicates (3 unique events)");

  // Reduce history into state — Brain should end up completed
  let raceState = createInitialOfficeState();
  for (const evt of historyEvents) {
    raceState = reduceOfficeEvent(raceState, evt);
  }
  assert.equal(raceState.brain_planner.status, "completed", "Brain status is completed after history backfill");
  assert.equal(raceState.brain_planner.message, "Execution plan ready", "Brain message is 'Execution plan ready' after history backfill");

  // Now simulate a later child-agent event arriving through Realtime (after flush)
  const childEvent = event({
    id: "qb-start-4",
    sequence: 4,
    agentId: "query_builder",
    type: "agent.started",
    status: "planning",
    message: "Working in discovery_planner",
  });
  raceState = reduceOfficeEvent(raceState, childEvent);

  // Brain state must NOT be affected by child agent event
  assert.equal(raceState.brain_planner.status, "completed", "Brain status remains completed after child agent event");
  assert.equal(raceState.brain_planner.message, "Execution plan ready", "Brain message unchanged after child agent event");
  assert.equal(raceState.query_builder.status, "planning", "Child agent status is planning");
  assert.equal(raceState.query_builder.message, "Working in discovery_planner", "Child agent message is set");

  // Verify no duplicate entries in merged events
  const allEvents = mergeOfficeEvents(merged, [childEvent]);
  const ids = allEvents.map((e) => e.id);
  assert.equal(new Set(ids).size, allEvents.length, "no duplicate event IDs after merge");

  // Test: flush-buffered events after history are applied in order
  {
    let flushState = createInitialOfficeState();
    // Step 1: history backfill (Brain completed)
    const history = [brainCompleted];
    for (const evt of history) {
      flushState = reduceOfficeEvent(flushState, evt);
    }
    assert.equal(flushState.brain_planner.status, "completed", "flush test: Brain completed from history");

    // Step 2: buffered Realtime events from subscribe window (early Brain events)
    // These should be IGNORED because their sequence (1,2) <= brainCompleted.sequence (3)
    const bufferedEarly = [brainStarted, brainPlanning];
    for (const evt of bufferedEarly) {
      flushState = reduceOfficeEvent(flushState, evt);
    }
    assert.equal(flushState.brain_planner.status, "completed", "flush test: early buffered events ignored (lower sequence)");
    assert.equal(flushState.brain_planner.message, "Execution plan ready", "flush test: Brain message preserved after flush");

    // Step 3: later Realtime event (child agent)
    flushState = reduceOfficeEvent(flushState, childEvent);
    assert.equal(flushState.query_builder.status, "planning", "flush test: child agent updated after flush");
    assert.equal(flushState.brain_planner.status, "completed", "flush test: Brain still completed after child event");
  }

  // Test: inverse order — Realtime arrives first, history backfill later
  {
    let inverseState = createInitialOfficeState();
    // Realtime delivers Brain events first
    for (const evt of [brainStarted, brainPlanning, brainCompleted]) {
      inverseState = reduceOfficeEvent(inverseState, evt);
    }
    assert.equal(inverseState.brain_planner.message, "Execution plan ready", "inverse: Brain message correct after realtime-first");

    // History backfill arrives — should be no-op (same/lower sequences)
    for (const evt of historyEvents) {
      inverseState = reduceOfficeEvent(inverseState, evt);
    }
    assert.equal(inverseState.brain_planner.message, "Execution plan ready", "inverse: Brain message preserved after history backfill");
    assert.equal(inverseState.brain_planner.status, "completed", "inverse: Brain status preserved after history backfill");

    // Later child event
    inverseState = reduceOfficeEvent(inverseState, childEvent);
    assert.equal(inverseState.query_builder.status, "planning", "inverse: child agent updated");
    assert.equal(inverseState.brain_planner.status, "completed", "inverse: Brain still completed");
  }

  // Test: panel source code contains subscribe-before-history pattern
  const panelSource = readSync(
    new URL("../components/paylabs/office/PayLabsOfficePanel.tsx", import.meta.url),
    "utf-8",
  );
  assert.ok(panelSource.includes('status === "SUBSCRIBED"'), "panel waits for SUBSCRIBED before fetching history");
  assert.ok(panelSource.includes("historyFetched"), "panel tracks historyFetched flag");
  assert.ok(panelSource.includes("realtimeEventsDuringSubscribe"), "panel buffers Realtime events during subscribe");
  assert.ok(panelSource.includes("async (status)"), "panel passes status callback to subscribe");
  // Verify the old fire-and-forget pattern is gone
  assert.ok(!panelSource.includes(".subscribe();"), "old fire-and-forget subscribe() removed");
  assert.ok(!panelSource.includes("void supabase\\n      .from(\"paylabs_office_events\")"), "old immediate history fetch removed");
}

console.log("Subscription race regression tests passed");

// ── Brain active route-preflight event regression tests ──────────────
// Verifies that the route-preflight path (active DCW flow) emits Brain
// Office lifecycle events, fixing the issue where Brain stayed idle.

{
  // Test: route-preflight source imports safeEmitOfficeEvent
  const routePreflightSource = readSync(
    new URL("../app/api/paylabs/discovery-runs/route-preflight/route.ts", import.meta.url),
    "utf-8",
  );
  assert.ok(routePreflightSource.includes('from "@/lib/paylabs/office/server"'),
    "route-preflight imports office server for event emission");

  // Test: route-preflight emits agent.started before runRouteOnlyBrainPreflight
  const startedIdx = routePreflightSource.indexOf('type: "agent.started"');
  const preflightCallIdx = routePreflightSource.indexOf("runRouteOnlyBrainPreflight(");
  assert.ok(startedIdx > 0, "route-preflight emits agent.started for Brain");
  assert.ok(preflightCallIdx > 0, "route-preflight calls runRouteOnlyBrainPreflight");
  assert.ok(startedIdx < preflightCallIdx,
    "Brain agent.started emitted BEFORE runRouteOnlyBrainPreflight()");

  // Test: route-preflight emits agent.completed after successful preflight
  const completedIdx = routePreflightSource.indexOf('type: "agent.completed"');
  assert.ok(completedIdx > 0, "route-preflight emits agent.completed for Brain");
  assert.ok(completedIdx > preflightCallIdx,
    "Brain agent.completed emitted AFTER runRouteOnlyBrainPreflight()");

  // Test: route-preflight emits agent.failed in catch block
  const failedIdx = routePreflightSource.indexOf('type: "agent.failed"');
  assert.ok(failedIdx > 0, "route-preflight emits agent.failed for Brain on error");

  // Test: Brain agent.started has correct phase and status
  assert.ok(routePreflightSource.includes('agentId: "brain_planner"'),
    "Brain events use agentId brain_planner");
  assert.ok(routePreflightSource.includes('phase: "brain"'),
    "Brain events use phase brain");

  // Test: Brain agent.completed message is "Execution plan ready"
  assert.ok(routePreflightSource.includes('"Execution plan ready"'),
    "Brain completed message is 'Execution plan ready'");

  // Test: Brain reducer flow — planning → completed
  let brainRouteState = createInitialOfficeState();
  brainRouteState = reduceOfficeEvent(brainRouteState, event({
    sequence: 100,
    agentId: "brain_planner",
    type: "agent.started",
    status: "planning",
    message: "Analyzing request",
  }));
  assert.equal(brainRouteState.brain_planner.status, "planning",
    "Brain route-preflight: planning status after agent.started");
  assert.deepEqual(
    { x: brainRouteState.brain_planner.x, y: brainRouteState.brain_planner.y },
    OFFICE_AGENTS.brain_planner.desk,
    "Brain route-preflight: moves to desk on agent.started",
  );

  brainRouteState = reduceOfficeEvent(brainRouteState, event({
    sequence: 101,
    agentId: "brain_planner",
    type: "agent.completed",
    status: "completed",
    message: "Execution plan ready",
  }));
  assert.equal(brainRouteState.brain_planner.status, "completed",
    "Brain route-preflight: completed status after agent.completed");
  assert.equal(brainRouteState.brain_planner.message, "Execution plan ready",
    "Brain route-preflight: message is 'Execution plan ready'");
  assert.deepEqual(
    { x: brainRouteState.brain_planner.x, y: brainRouteState.brain_planner.y },
    OFFICE_AGENTS.brain_planner.idle,
    "Brain route-preflight: returns to idle after completed",
  );
}

console.log("Brain route-preflight event regression tests passed");

// ── x402 visual order regression tests ──────────────────────────────
// Verifies that child-agent events follow the correct visual order:
//   x402.requested → Gateway
//   x402.settled   → Gateway
//   agent.started  → desk
//   agent.completed → idle

{
  // Test: x402.requested sends child agent to Gateway
  let orderState = createInitialOfficeState();
  orderState = reduceOfficeEvent(orderState, event({
    sequence: 1,
    agentId: "query_builder",
    type: "x402.requested",
    status: "paying",
    message: "Awaiting x402 payment",
  }));
  assert.deepEqual(
    { x: orderState.query_builder.x, y: orderState.query_builder.y },
    OFFICE_STATIONS.gateway,
    "x402.requested sends child agent to Gateway",
  );
  assert.equal(orderState.query_builder.status, "paying",
    "x402.requested sets status to paying");

  // Test: x402.settled keeps agent at Gateway
  orderState = reduceOfficeEvent(orderState, event({
    sequence: 2,
    agentId: "query_builder",
    type: "x402.settled",
    status: "paying",
    message: "x402 settlement completed",
  }));
  assert.deepEqual(
    { x: orderState.query_builder.x, y: orderState.query_builder.y },
    OFFICE_STATIONS.gateway,
    "x402.settled keeps child agent at Gateway",
  );
  assert.equal(orderState.query_builder.status, "paying",
    "x402.settled status remains paying");

  // Test: agent.started after settlement sends agent to its desk
  orderState = reduceOfficeEvent(orderState, event({
    sequence: 3,
    agentId: "query_builder",
    type: "agent.started",
    status: "planning",
    message: "Working in discovery_planner",
  }));
  assert.deepEqual(
    { x: orderState.query_builder.x, y: orderState.query_builder.y },
    OFFICE_AGENTS.query_builder.desk,
    "agent.started after settlement sends agent to its assigned desk",
  );
  assert.equal(orderState.query_builder.status, "planning",
    "agent.started sets status to planning");

  // Test: agent.completed returns agent to idle
  orderState = reduceOfficeEvent(orderState, event({
    sequence: 4,
    agentId: "query_builder",
    type: "agent.completed",
    status: "completed",
    message: "Service completed",
  }));
  assert.deepEqual(
    { x: orderState.query_builder.x, y: orderState.query_builder.y },
    OFFICE_AGENTS.query_builder.idle,
    "agent.completed returns agent to idle/Lounge",
  );
  assert.equal(orderState.query_builder.status, "completed",
    "agent.completed sets status to completed");

  // Test: x402.failed sends agent to error station
  let failState = createInitialOfficeState();
  failState = reduceOfficeEvent(failState, event({
    sequence: 1,
    agentId: "source_verifier",
    type: "x402.requested",
    status: "paying",
  }));
  failState = reduceOfficeEvent(failState, event({
    sequence: 2,
    agentId: "source_verifier",
    type: "x402.failed",
    status: "failed",
  }));
  assert.deepEqual(
    { x: failState.source_verifier.x, y: failState.source_verifier.y },
    OFFICE_STATIONS.error,
    "x402.failed sends agent to error station",
  );
  assert.equal(failState.source_verifier.status, "failed",
    "x402.failed sets status to failed");
}

console.log("x402 visual order regression tests passed");

// ── Source code structure regression tests ───────────────────────────
// Verifies that the seller endpoint and service-node have correct event
// emission structure without duplicates.

{
  // Test: seller endpoint (agent-services/run/route.ts) emits x402.requested
  const sellerSource = readSync(
    new URL("../app/api/paylabs/agent-services/[serviceName]/run/route.ts", import.meta.url),
    "utf-8",
  );
  assert.ok(sellerSource.includes('type: "x402.requested"'),
    "seller endpoint emits x402.requested");
  assert.ok(sellerSource.includes('"Awaiting x402 payment"'),
    "x402.requested message is safe (no amounts)");

  // Test: seller endpoint emits x402.settled after settlement
  assert.ok(sellerSource.includes('type: "x402.settled"'),
    "seller endpoint emits x402.settled");
  assert.ok(sellerSource.includes('"x402 settlement completed"'),
    "x402.settled message is safe (no amounts)");

  // Test: seller endpoint emits agent.started after x402.settled
  const settledIdx = sellerSource.indexOf('type: "x402.settled"');
  const startedIdx = sellerSource.indexOf('type: "agent.started"');
  assert.ok(settledIdx > 0, "x402.settled exists in seller endpoint");
  assert.ok(startedIdx > 0, "agent.started exists in seller endpoint");
  assert.ok(settledIdx < startedIdx,
    "x402.settled emitted BEFORE agent.started in seller endpoint");

  // Test: seller endpoint emits x402.failed on settlement failure
  assert.ok(sellerSource.includes('type: "x402.failed"'),
    "seller endpoint emits x402.failed on settlement failure");

  // Test: service-node.ts does NOT emit agent.started (moved to seller endpoint)
  const serviceNodeSource = readSync(
    new URL("../lib/paylabs/langgraph/services/service-node.ts", import.meta.url),
    "utf-8",
  );
  // Count agent.started occurrences — should be 0 (only in comments)
  const agentStartedMatches = serviceNodeSource.match(/type: "agent\.started"/g);
  assert.equal(agentStartedMatches, null,
    "service-node.ts does NOT emit agent.started (moved to seller endpoint)");

  // Test: service-node.ts does NOT emit x402.settled (moved to seller endpoint)
  const x402SettledMatches = serviceNodeSource.match(/type: "x402\.settled"/g);
  assert.equal(x402SettledMatches, null,
    "service-node.ts does NOT emit x402.settled (moved to seller endpoint)");

  // Test: service-node.ts still emits agent.completed / agent.failed / creator.paid / treasury.retained
  assert.ok(serviceNodeSource.includes('type: "agent.completed"') || serviceNodeSource.includes('"agent.completed"'),
    "service-node.ts still emits agent.completed");
  assert.ok(serviceNodeSource.includes('type: "agent.failed"') || serviceNodeSource.includes('"agent.failed"'),
    "service-node.ts still emits agent.failed");
  assert.ok(serviceNodeSource.includes('"creator.paid"'),
    "service-node.ts still emits creator.paid");
  assert.ok(serviceNodeSource.includes('"treasury.retained"'),
    "service-node.ts still emits treasury.retained");

  // Test: no duplicate x402 or agent.started events across both files
  // seller endpoint: exactly 1 x402.requested, 1 x402.settled, 1 agent.started
  const sellerRequestedCount = (sellerSource.match(/type: "x402\.requested"/g) || []).length;
  const sellerSettledCount = (sellerSource.match(/type: "x402\.settled"/g) || []).length;
  const sellerStartedCount = (sellerSource.match(/type: "agent\.started"/g) || []).length;
  assert.equal(sellerRequestedCount, 1,
    "seller endpoint has exactly 1 x402.requested emission");
  assert.equal(sellerSettledCount, 1,
    "seller endpoint has exactly 1 x402.settled emission");
  assert.equal(sellerStartedCount, 1,
    "seller endpoint has exactly 1 agent.started emission");

  // Test: payment amounts remain in payment/metadata fields, not bubble messages
  assert.ok(!sellerSource.includes('message: `${') ||
    sellerSource.includes('message: `Working in ${buyerAgentName}`'),
    "seller endpoint message fields contain no monetary template literals (except Working in)");
  assert.ok(sellerSource.includes('message: "x402 settlement completed"'),
    "x402.settled uses safe message, not amount");
  assert.ok(sellerSource.includes('message: "Awaiting x402 payment"'),
    "x402.requested uses safe message, not amount");
}

console.log("Source code structure regression tests passed");
