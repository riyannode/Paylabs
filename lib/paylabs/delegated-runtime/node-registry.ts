/**
 * Delegated Runtime Node Registry
 *
 * Defines x402 payment config for Brain and macro-node endpoints.
 * Payment graph:
 *   run_budget_controller → Brain → macro-node → child service
 */

import type { MacroNodePhase } from "./types";
import type { ServiceName } from "../agent-services/types";

// ─── Types ───────────────────────────────────────────────────

export interface BrainNodeConfig {
  nodeType: "brain";
  sellerWalletAddressEnv: string;
  buyerWalletIdEnv: string;
  fixedBrainFeeUsdc: number;
  endpointPath: string;
}

export interface MacroNodeConfig {
  nodeType: "macro_node";
  nodeName: MacroNodePhase;
  sellerWalletAddressEnv: string;
  buyerWalletIdEnv: string;
  fixedNodeFeeUsdc: number;
  endpointPath: string;
  childServices: ServiceName[];
}

export type DelegatedNodeConfig = BrainNodeConfig | MacroNodeConfig;

// ─── Brain Config ────────────────────────────────────────────

export const BRAIN_NODE: BrainNodeConfig = {
  nodeType: "brain",
  sellerWalletAddressEnv: "PAYLABS_BRAIN_SELLER_WALLET_ADDRESS",
  buyerWalletIdEnv: "PAYLABS_BRAIN_BUYER_WALLET_ID",
  fixedBrainFeeUsdc: 0.000001,
  endpointPath: "/api/paylabs/brain/run",
};

// ─── Macro-Node Configs ─────────────────────────────────────

export const MACRO_NODES: Record<MacroNodePhase, MacroNodeConfig> = {
  discovery_planner: {
    nodeType: "macro_node",
    nodeName: "discovery_planner",
    sellerWalletAddressEnv: "PAYLABS_NODE_DISCOVERY_PLANNER_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_NODE_DISCOVERY_PLANNER_BUYER_WALLET_ID",
    fixedNodeFeeUsdc: 0.000001,
    endpointPath: "/api/paylabs/macro-nodes/discovery_planner/run",
    childServices: ["intent_planner", "query_builder", "signal_scout"],
  },
  payment_decision: {
    nodeType: "macro_node",
    nodeName: "payment_decision",
    sellerWalletAddressEnv: "PAYLABS_NODE_PAYMENT_DECISION_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_NODE_PAYMENT_DECISION_BUYER_WALLET_ID",
    fixedNodeFeeUsdc: 0.000001,
    endpointPath: "/api/paylabs/macro-nodes/payment_decision/run",
    childServices: [
      "intent_matcher", "source_verifier", "value_allocator",
      "trust_verifier", "payment_decider",
    ],
  },
  settlement_memory: {
    nodeType: "macro_node",
    nodeName: "settlement_memory",
    sellerWalletAddressEnv: "PAYLABS_NODE_SETTLEMENT_MEMORY_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_NODE_SETTLEMENT_MEMORY_BUYER_WALLET_ID",
    fixedNodeFeeUsdc: 0.000001,
    endpointPath: "/api/paylabs/macro-nodes/settlement_memory/run",
    childServices: ["payment_router"],
  },
};

// ─── Lookup Helpers ──────────────────────────────────────────

export function getBrainConfig(): BrainNodeConfig {
  return BRAIN_NODE;
}

export function getMacroNodeConfig(nodeName: MacroNodePhase): MacroNodeConfig {
  return MACRO_NODES[nodeName];
}

export function isValidMacroNodeName(name: string): name is MacroNodePhase {
  return name in MACRO_NODES;
}

export function resolveNodeSellerWallet(config: DelegatedNodeConfig): string {
  const address = (process.env[config.sellerWalletAddressEnv] || "").trim();
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error(
      `config_error: ${config.sellerWalletAddressEnv} must be a valid EVM address`
    );
  }
  return address.toLowerCase();
}

export function resolveNodeBuyerWalletId(config: DelegatedNodeConfig): string {
  const walletId = (process.env[config.buyerWalletIdEnv] || "").trim();
  if (!walletId) {
    throw new Error(`config_error: ${config.buyerWalletIdEnv} must be set`);
  }
  return walletId;
}
