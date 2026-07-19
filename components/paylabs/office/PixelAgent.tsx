"use client";

import type { CSSProperties } from "react";
import { OFFICE_AGENTS } from "@/lib/paylabs/office/registry";
import type { OfficeAgentViewState } from "@/lib/paylabs/office/types";
import { sanitizeDisplayMessage } from "@/lib/paylabs/office/sanitizer";

export function PixelAgent({ agent }: { agent: OfficeAgentViewState }) {
  const definition = OFFICE_AGENTS[agent.id];
  const active = !["idle", "completed", "failed"].includes(agent.status);
  const flipped = agent.facing === "left";
  const style = {
    "--agent-color": definition.color,
    transform: `translate3d(${agent.x}px, ${agent.y}px, 0) scaleX(${flipped ? -1 : 1})`,
  } as CSSProperties;

  const displayMessage = sanitizeDisplayMessage(agent.message);

  return (
    <button
      type="button"
      className={`po-agent-wrap is-${agent.status}${agent.id === "brain_planner" ? " is-brain" : ""}`}
      style={style}
      aria-label={`${definition.label}: ${agent.status}`}
    >
      <div className="po-agent-meta" style={{ transform: `scaleX(${flipped ? -1 : 1})` }}>
        <div className="po-agent-label">{definition.shortLabel}</div>
        {displayMessage ? <div className="po-agent-bubble">{displayMessage.slice(0, 52)}</div> : null}
      </div>

      <div className={["po-agent", active ? "is-working" : "", `is-${agent.status}`].join(" ")}>
        <span className="po-hair" />
        <span className="po-head">
          <span className="po-eye po-eye-left" />
          <span className="po-eye po-eye-right" />
        </span>
        <span className="po-body" />
        <span className="po-arm po-arm-left" />
        <span className="po-arm po-arm-right" />
        <span className="po-leg po-leg-left" />
        <span className="po-leg po-leg-right" />
      </div>
    </button>
  );
}
