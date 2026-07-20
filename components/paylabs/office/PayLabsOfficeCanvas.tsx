"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import type { OfficeAgentViewState } from "@/lib/paylabs/office/types";
import { isOfficeMacroAgentId } from "@/lib/paylabs/office/registry";
import { OFFICE_AGENTS } from "@/lib/paylabs/office/registry";
import { PixelAgent } from "./PixelAgent";
import { PixelDesk } from "./PixelDesk";

// ── Beam geometry constants ───────────────────────────────────
// x402 machine inner center in stage coordinates
// Gateway zone left=390, x402 machine left=70 top=80, 5px border, inner 66×44
const X402_BORDER_PX = 5;
// x402 machine local center (within the 76×54 box)
const X402_LOCAL_CENTER_X = 38;
const X402_LOCAL_CENTER_Y = 27;
const X402_CENTER_X = 390 + 70 + X402_BORDER_PX + X402_LOCAL_CENTER_X; // 503
const X402_CENTER_Y = 500 - 182 + 80 + X402_BORDER_PX + X402_LOCAL_CENTER_Y; // 430
// Sprite visual center offset from station position
const SPRITE_CENTER_X = 18;
const SPRITE_CENTER_Y = 30.5;

interface BeamInfo {
  macroId: "discovery_planner" | "payment_decision" | "settlement_memory";
  cssClass: string;
  typeClass: string;
}

function computeBeams(agents: OfficeAgentViewState[]): BeamInfo[] {
  const beams: BeamInfo[] = [];
  for (const agent of agents) {
    if (!agent.beam?.active || !isOfficeMacroAgentId(agent.id)) continue;
    const macroId = agent.id as "discovery_planner" | "payment_decision" | "settlement_memory";
    const cssClass =
      macroId === "discovery_planner"
        ? "is-discovery"
        : macroId === "payment_decision"
          ? "is-payment"
          : "is-settlement";
    const typeClass = `is-${agent.beam.type}`;
    beams.push({ macroId, cssClass, typeClass });
  }
  return beams;
}

function beamStyle(agentId: "discovery_planner" | "payment_decision" | "settlement_memory"): CSSProperties {
  const def = OFFICE_AGENTS[agentId];
  const macroCenterX = def.desk.x + SPRITE_CENTER_X;
  const macroCenterY = def.desk.y + SPRITE_CENTER_Y;
  const dx = macroCenterX - X402_CENTER_X;
  const dy = macroCenterY - X402_CENTER_Y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return {
    left: X402_LOCAL_CENTER_X,
    top: X402_LOCAL_CENTER_Y,
    width: distance,
    transform: `rotate(${angleDeg}deg)`,
  };
}

export function PayLabsOfficeCanvas({
  agents,
  paused,
  stageStyle,
}: {
  agents: OfficeAgentViewState[];
  paused: boolean;
  stageStyle: CSSProperties;
}) {
  const beams = computeBeams(agents);

  return (
    <div className={`po-stage ${paused ? "is-paused" : ""}`} style={stageStyle}>
      <section className="po-room po-room-control">
        <strong>CONTROL</strong>
        <div className="po-clock">◷</div>
        <div className="po-boss-desk">
          <div className="po-monitor" />
          <div className="po-chart-screen" />
        </div>
      </section>

      <section className="po-room po-room-discovery">
        <strong>DISCOVERY LAB</strong>
        <div className="po-room-accent po-accent-blue" />
        <div className="po-desk-grid po-discovery-desks">
          <PixelDesk />
          <PixelDesk />
          <PixelDesk />
          <PixelDesk />
        </div>
        <div className="po-rss-scanner">RSS</div>
      </section>

      <section className="po-room po-room-payment">
        <strong>PAYMENT &amp; RISK</strong>
        <div className="po-room-accent po-accent-orange" />
        <div className="po-desk-grid po-payment-desks">
          <PixelDesk />
          <PixelDesk />
          <PixelDesk />
          <PixelDesk />
          <PixelDesk />
        </div>
      </section>

      <section className="po-room po-room-settlement">
        <strong>SETTLEMENT</strong>
        <div className="po-room-accent po-accent-green" />
        <div className="po-desk-grid po-settlement-desks">
          <PixelDesk />
          <PixelDesk />
          <PixelDesk />
        </div>
      </section>

      <section className="po-bottom-zone po-lounge">
        <strong>LOUNGE</strong>
        <div className="po-couch" />
        <div className="po-table" />
        <div className="po-plant" />
      </section>

      <section className="po-bottom-zone po-gateway-zone">
        <strong>CIRCLE GATEWAY</strong>
        <Link href="/explorer" className="po-gateway-machine po-clickable">
          <span className="po-x402-beams" aria-hidden="true">
            {beams.map((b) => (
              <span
                key={b.macroId}
                className={`po-x402-beam ${b.cssClass} ${b.typeClass}`}
                style={beamStyle(b.macroId)}
              />
            ))}
          </span>
          <span className="po-x402-title">x402</span>
        </Link>
        <Link href="/receipts" className="po-receipt-printer po-clickable">
          RECEIPT
        </Link>
      </section>

      <section className="po-bottom-zone po-treasury-zone">
        <strong>CREATOR PAYOUT / TREASURY</strong>
        <div className="po-treasury-safe">CREATOR PAYOUT</div>
        <div className="po-arc-screen">TREASURY RESERVE</div>
      </section>

      {agents.map((agent) => (
        <PixelAgent key={agent.id} agent={agent} />
      ))}
    </div>
  );
}
