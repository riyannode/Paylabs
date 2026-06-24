"use client";

import { useState, useEffect } from "react";

/* ── Wallet picker shown when user clicks "Connect wallet" ── */

type Props = {
  open: boolean;
  onClose: () => void;
  onSelectUcw: () => void;
  onSelectDcw: () => void;
};

export default function WalletPicker({ open, onClose, onSelectUcw, onSelectDcw }: Props) {
  if (!open) return null;

  return (
    <div className="pl-wallet-overlay-v3" onClick={onClose}>
      <div className="pl-wallet-modal-v3" onClick={(e) => e.stopPropagation()}>
        <button className="pl-wallet-x-v3" onClick={onClose} aria-label="Close">×</button>

        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Connect Wallet</h2>
          <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            Choose how you want to connect
          </p>
        </div>

        <div className="pl-picker-grid">
          <button className="pl-picker-card" onClick={onSelectUcw}>
            <div className="pl-picker-icon">🔐</div>
            <div className="pl-picker-title">UCW</div>
            <div className="pl-picker-desc">Self-Custody</div>
            <div className="pl-picker-detail">Social / Email / PIN</div>
            <div className="pl-picker-detail">You hold your keys</div>
          </button>

          <button className="pl-picker-card pl-picker-card-accent" onClick={onSelectDcw}>
            <div className="pl-picker-icon">⚡</div>
            <div className="pl-picker-title">DCW</div>
            <div className="pl-picker-desc">Auto-Pay</div>
            <div className="pl-picker-detail">Zero signing</div>
            <div className="pl-picker-detail">Seamless x402</div>
          </button>
        </div>
      </div>
    </div>
  );
}
