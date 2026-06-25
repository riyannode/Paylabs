"use client";

import { ChevronRight, ShieldCheck, Zap } from "lucide-react";

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
      <div
        className="pl-wallet-modal-v3 pl-picker-shell"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="pl-wallet-x-v3" onClick={onClose} aria-label="Close">
          ×
        </button>

        <div className="pl-picker-head">
          <h2>Connect wallet</h2>
          <p>Choose how PayLabs should authorize payments.</p>
        </div>

        <div className="pl-picker-grid">
          <button className="pl-picker-card" onClick={onSelectUcw}>
            <span className="pl-picker-icon" aria-hidden="true">
              <ShieldCheck size={21} strokeWidth={2.2} />
            </span>

            <span className="pl-picker-copy">
              <span className="pl-picker-title-row">
                <b>Creator Wallet</b>
                <em>Self-custody</em>
              </span>
              <span>Publish paid content and APIs with your own Circle wallet.</span>
            </span>

            <ChevronRight className="pl-picker-chevron" size={18} strokeWidth={2.2} />
          </button>

          <button className="pl-picker-card" onClick={onSelectDcw}>
            <span className="pl-picker-icon pl-picker-icon-blue" aria-hidden="true">
              <Zap size={21} strokeWidth={2.2} />
            </span>

            <span className="pl-picker-copy">
              <span className="pl-picker-title-row">
                <b>User Wallet</b>
                <em>Fast access</em>
              </span>
              <span>Use PayLabs with automatic payment authorization.</span>
            </span>

            <ChevronRight className="pl-picker-chevron" size={18} strokeWidth={2.2} />
          </button>
        </div>
      </div>
    </div>
  );
}
