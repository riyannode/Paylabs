"use client";

import type { CSSProperties } from "react";
import type { OfficeAgentViewState } from "@/lib/paylabs/office/types";
import { PixelAgent } from "./PixelAgent";
import { PixelDesk } from "./PixelDesk";

export function PayLabsOfficeCanvas({
  agents,
  paused,
  stageStyle,
}: {
  agents: OfficeAgentViewState[];
  paused: boolean;
  stageStyle: CSSProperties;
}) {
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
        <div className="po-gateway-machine">
          <span>x402</span>
        </div>
        <div className="po-receipt-printer">RECEIPT</div>
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
