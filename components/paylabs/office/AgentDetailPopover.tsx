"use client";

import type { OfficeAgentViewState } from "@/lib/paylabs/office/types";
import { OFFICE_AGENTS } from "@/lib/paylabs/office/registry";

export function AgentDetailPopover({ agent }: { agent: OfficeAgentViewState }) {
  const definition = OFFICE_AGENTS[agent.id];
  return (
    <div className="po-agent-popover">
      <strong>{definition.label}</strong>
      <span>{agent.status}</span>
    </div>
  );
}
