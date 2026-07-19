"use client";

import type { OfficeAgentViewState, OfficeRunSummary, PayLabsOfficeEvent } from "@/lib/paylabs/office/types";
import { OFFICE_AGENTS } from "@/lib/paylabs/office/registry";
import { safeExplorerUrl } from "@/lib/paylabs/x402/payment-links";

export function PayLabsOfficeDashboard({
  agents,
  events,
  run,
}: {
  agents: OfficeAgentViewState[];
  events: PayLabsOfficeEvent[];
  run: OfficeRunSummary;
}) {
  const working = agents.filter((agent) => !["idle", "completed", "failed"].includes(agent.status)).length;
  const idle = agents.filter((agent) => agent.status === "idle").length;
  const completed = agents.filter((agent) => agent.status === "completed").length;
  const failed = agents.filter((agent) => agent.status === "failed").length;
  const settledEvents = events.filter((event) => event.type === "x402.settled");
  const settledUsdc = settledEvents.reduce((sum, event) => {
    const amount = Number(event.payment?.amountUsdc ?? 0);
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);

  return (
    <aside className="po-dashboard">
      <div className="po-dashboard-title">
        <span>PAYLABS OFFICE</span>
        <small>LIVE RUNTIME</small>
      </div>

      <section className="po-panel">
        <h3>RUN STATUS</h3>
        <dl>
          <div><dt>Run</dt><dd>{run.runId ? run.runId.slice(0, 10) : "Idle"}</dd></div>
          <div><dt>Tier</dt><dd>{run.tier ?? "—"}</dd></div>
          <div><dt>Status</dt><dd>{run.status ?? "idle"}</dd></div>
          <div><dt>Planned</dt><dd>{run.plannedCostUsdc == null ? "—" : `${run.plannedCostUsdc.toFixed(6)} USDC`}</dd></div>
        </dl>
      </section>

      <section className="po-panel">
        <h3>X402</h3>
        <dl>
          <div><dt>Settled edges</dt><dd>{settledEvents.length}</dd></div>
          <div><dt>Paid graph</dt><dd>{run.paidEdges}/{run.totalEdges}</dd></div>
          <div><dt>Office event total</dt><dd>{settledUsdc.toFixed(6)} USDC</dd></div>
          <div><dt>Receipt</dt><dd>{run.receiptReady ? "ready" : "pending"}</dd></div>
        </dl>
        <div className="po-payment-list">
          {settledEvents.slice(-4).reverse().map((event) => {
            const href = safeExplorerUrl(event.payment?.explorerUrl ?? null);
            return (
              <div key={event.id} className="po-payment-row">
                <div>
                  <strong>{event.agentId ?? "service"}</strong>
                  <span>{event.payment?.amountUsdc ?? "0"} USDC</span>
                </div>
                {href ? <a href={href} target="_blank" rel="noreferrer">View</a> : <span>Settled</span>}
              </div>
            );
          })}
        </div>
      </section>

      <section className="po-panel">
        <h3>AGENTS</h3>
        <div className="po-agent-stats">
          <span>Working {working}</span>
          <span>Idle {idle}</span>
          <span>Done {completed}</span>
          <span>Failed {failed}</span>
        </div>
        <div className="po-agent-directory">
          {agents.map((agent) => (
            <div key={agent.id}>
              <i className={`po-status-dot is-${agent.status}`} />
              <span>{OFFICE_AGENTS[agent.id].shortLabel}</span>
              <small>{agent.status}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="po-panel po-activity-panel">
        <h3>ACTIVITY LOG</h3>
        <div className="po-activity-log">
          {events.length === 0 ? (
            <span>No active query.</span>
          ) : (
            events.slice(-9).reverse().map((event) => (
              <span key={event.id}>[{new Date(event.createdAt).toLocaleTimeString()}] {event.title}</span>
            ))
          )}
        </div>
      </section>
    </aside>
  );
}
