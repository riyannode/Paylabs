/**
 * Withdrawal State Machine
 *
 * Manages status transitions with compare-and-set (CAS) semantics.
 * Only one concurrent transition can win.
 */

import type { WithdrawalStatus } from "./gateway-types";

// ─── Valid Transitions ───────────────────────────────────────

const VALID_TRANSITIONS: Record<WithdrawalStatus, WithdrawalStatus[]> = {
  prepared:                  ["burn_signature_pending", "failed", "expired"],
  burn_signature_pending:    ["burn_signed", "failed", "expired"],
  burn_signed:               ["gateway_submitted", "failed"],
  gateway_submitted:         ["attestation_received", "reconciliation_required", "failed"],
  attestation_received:      ["mint_submission_pending", "mint_approval_pending", "failed"],
  mint_submission_pending:   ["mint_submitted", "reconciliation_required", "failed"],
  mint_approval_pending:     ["mint_submitted", "failed"],
  mint_submitted:            ["finalized", "reconciliation_required", "failed"],
  finalized:                 [],
  failed:                    [],
  expired:                   [],
  reconciliation_required:   ["failed", "reconciliation_required"],
};

/**
 * Check if a status transition is valid.
 */
export function isValidTransition(from: WithdrawalStatus, to: WithdrawalStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Get the expected next status for a DCW withdrawal.
 * DCW has no browser approval steps — transitions are instant.
 */
export function getNextDcwStatus(current: WithdrawalStatus): WithdrawalStatus | null {
  switch (current) {
    case "prepared": return "burn_signed";          // signing is instant for DCW
    case "burn_signed": return "gateway_submitted";
    case "gateway_submitted": return "attestation_received";
    case "attestation_received": return "mint_submitted"; // mint is instant for DCW
    case "mint_submitted": return null;              // finalized by poll
    default: return null;
  }
}

/**
 * Get the expected next status for a UCW withdrawal.
 * UCW requires browser approval for signing and minting.
 */
export function getNextUcwStatus(current: WithdrawalStatus): WithdrawalStatus | null {
  switch (current) {
    case "prepared": return "burn_signature_pending";
    case "burn_signature_pending": return null;      // awaiting browser
    case "burn_signed": return "gateway_submitted";
    case "gateway_submitted": return "attestation_received";
    case "attestation_received": return "mint_approval_pending";
    case "mint_approval_pending": return null;        // awaiting browser
    case "mint_submitted": return null;               // finalized by poll
    default: return null;
  }
}

/** Terminal statuses — no further transitions possible */
export const TERMINAL_STATUSES: WithdrawalStatus[] = ["finalized", "failed", "expired"];

/** Statuses that indicate the withdrawal is in progress */
export const ACTIVE_STATUSES: WithdrawalStatus[] = [
  "prepared",
  "burn_signature_pending",
  "burn_signed",
  "gateway_submitted",
  "attestation_received",
  "mint_approval_pending",
  "mint_submitted",
];

/** Statuses that need reconciliation */
export const RECONCILIATION_STATUSES: WithdrawalStatus[] = [
  "gateway_submitted",
  "mint_submitted",
  "reconciliation_required",
];
