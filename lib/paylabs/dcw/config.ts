/**
 * DCW (Developer-Controlled Wallet) Configuration
 *
 * Centralized config for contract addresses, chain IDs, and health diagnostics.
 * All addresses are validated defaults for Arc Testnet.
 * Override via environment variables for mainnet.
 *
 * No secrets. No raw payload exposure.
 */

// ─── Chain Config ───────────────────────────────────────────

export const DCW_CHAIN = process.env.PAYLABS_DCW_CHAIN || "ARC-TESTNET";
export const DCW_CHAIN_ID = Number(process.env.PAYLABS_DCW_CHAIN_ID || "5042002");

// ─── Contract Addresses (env-overridable, verified defaults) ─

/** USDC token contract on Arc Testnet */
export const USDC_CONTRACT_ADDRESS =
  process.env.PAYLABS_USDC_CONTRACT_ADDRESS ||
  process.env.NEXT_PUBLIC_ARC_USDC_ADDRESS ||
  "0x3600000000000000000000000000000000000000";

/** Gateway WalletBatched contract on Arc Testnet */
export const GATEWAY_CONTRACT_ADDRESS =
  process.env.PAYLABS_GATEWAY_CONTRACT_ADDRESS ||
  "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

// ─── Validation ─────────────────────────────────────────────

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function isValidAddress(addr: string): boolean {
  return ADDRESS_RE.test(addr);
}

// ─── Health Diagnostic ──────────────────────────────────────

export interface DcwHealthDiagnostic {
  dcw_chain: string;
  dcw_chain_id: number;
  usdc_contract_configured: boolean;
  gateway_contract_configured: boolean;
  usdc_contract_source: "env" | "default";
  gateway_contract_source: "env" | "default";
}

export function getDcwHealth(): DcwHealthDiagnostic {
  const usdcFromEnv = !!(process.env.PAYLABS_USDC_CONTRACT_ADDRESS || process.env.NEXT_PUBLIC_ARC_USDC_ADDRESS);
  const gwFromEnv = !!process.env.PAYLABS_GATEWAY_CONTRACT_ADDRESS;

  return {
    dcw_chain: DCW_CHAIN,
    dcw_chain_id: DCW_CHAIN_ID,
    usdc_contract_configured: isValidAddress(USDC_CONTRACT_ADDRESS),
    gateway_contract_configured: isValidAddress(GATEWAY_CONTRACT_ADDRESS),
    usdc_contract_source: usdcFromEnv ? "env" : "default",
    gateway_contract_source: gwFromEnv ? "env" : "default",
  };
}
