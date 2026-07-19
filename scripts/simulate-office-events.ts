import { emitOfficeEvent } from "../lib/paylabs/office/server";
import type { PayLabsOfficeEvent } from "../lib/paylabs/office/types";

const runId = process.argv[2];

if (process.env.NODE_ENV === "production") {
  throw new Error("Refusing to simulate PayLabs office events in production");
}

if (!runId) {
  throw new Error("Usage: pnpm tsx scripts/simulate-office-events.ts <run-id>");
}

type Input = Omit<PayLabsOfficeEvent, "id" | "sequence" | "createdAt" | "runId">;

const metadata = { simulated: true, note: "DEV_ONLY visual simulation. Not production payment evidence." };

const events: Input[] = [
  { type: "run.started", phase: "brain", status: "planning", agentId: "brain_planner", title: "Simulated run started", message: "DEV_ONLY office preview", metadata },
  { type: "agent.started", phase: "brain", status: "planning", agentId: "brain_planner", title: "Brain started planning", message: "Selecting route tier", metadata },
  { type: "agent.completed", phase: "brain", status: "completed", agentId: "brain_planner", title: "Execution plan locked", message: "advanced route · 12 services", metadata },
  { type: "agent.started", phase: "discovery_planner", status: "planning", agentId: "intent_planner", title: "Intent started", metadata },
  { type: "agent.completed", phase: "discovery_planner", status: "completed", agentId: "intent_planner", title: "Intent completed", metadata },
  { type: "agent.started", phase: "discovery_planner", status: "planning", agentId: "query_builder", title: "Query started", metadata },
  { type: "agent.completed", phase: "discovery_planner", status: "completed", agentId: "query_builder", title: "Query completed", metadata },
  { type: "agent.started", phase: "discovery_planner", status: "searching", agentId: "signal_scout", title: "Scout started", metadata },
  { type: "x402.settled", phase: "discovery_planner", status: "paying", agentId: "signal_scout", title: "Simulated x402 settled", message: "0.000001 USDC · simulated", payment: { amountUsdc: "0.000001", status: "settled", txHash: null, explorerUrl: null }, metadata },
  { type: "agent.started", phase: "payment_decision", status: "verifying", agentId: "source_verifier", title: "Source verifier started", metadata },
  { type: "agent.completed", phase: "payment_decision", status: "completed", agentId: "source_verifier", title: "Source verifier completed", metadata },
  { type: "agent.completed", phase: "payment_decision", status: "completed", agentId: "payment_decider", title: "Payment decider completed", metadata },
  { type: "agent.started", phase: "settlement_memory", status: "verifying", agentId: "creator_attribution", title: "Creator attribution started", metadata },
  { type: "agent.completed", phase: "settlement_memory", status: "completed", agentId: "creator_attribution", title: "Creator attribution completed", metadata },
  { type: "agent.started", phase: "settlement_memory", status: "settling", agentId: "creator_payout_router", title: "Payout router started", metadata },
  { type: "creator.paid", phase: "settlement_memory", status: "settling", agentId: "creator_payout_router", title: "Simulated creator payout", message: "0.000020 USDC · simulated", payment: { amountUsdc: "0.000020", status: "settled", txHash: null, explorerUrl: null }, metadata },
  { type: "run.completed", status: "completed", title: "Simulated run completed", metadata },
];

for (const input of events) {
  const emitted = await emitOfficeEvent({ runId, ...input });
  console.log(`${emitted.sequence}: ${emitted.type} ${emitted.title}`);
}
