/**
 * Delegated Runtime Node Registry
 *
 * Defines x402 payment config for Brain and macro-node endpoints.
 * Payment graph:
 *   controller/user → Brain (treasury) → macro-node (allocation) → child service
 *
 * All payments use Circle GatewayWalletBatched x402.
 */

import type { MacroNodePhase } from "./types";
import type { ServiceName } from "../agent-services/types";
import { FIXED_FEES_USDC } from "./quote-engine";
import { getMacroNodeServicesForTier } from "./tier-service-bundles";

// ─── Constants ───────────────────────────────────────────────

/** Re-export from quote-engine (single source of truth) */
export const BRAIN_TREASURY_FEE_USDC = FIXED_FEES_USDC.brainTreasury;
export const MACRO_NODE_FEE_USDC = FIXED_FEES_USDC.macroNode;
export const CHILD_SERVICE_FEE_USDC = FIXED_FEES_USDC.serviceEdge;

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
  /** Tier this macro-node belongs to */
  tierLabel: "easy" | "normal" | "advanced";
  /** Circle GatewayWalletBatched x402 */
  brainPaymentMode: "circle_gateway_wallet_batched";
  /** How this macro pays its children: per-child Circle x402 fallback */
  childPaymentMode: "circle_gateway_wallet_batched_per_child_fallback";
  /** Which tiered summary key this macro produces */
  outputSummaryKey: "easy_summary" | "normal_summary" | "advanced_summary";
}

export type DelegatedNodeConfig = BrainNodeConfig | MacroNodeConfig;

// ─── Brain Config ────────────────────────────────────────────

export const BRAIN_NODE: BrainNodeConfig = {
  nodeType: "brain",
  sellerWalletAddressEnv: "PAYLABS_BRAIN_SELLER_WALLET_ADDRESS",
  buyerWalletIdEnv: "PAYLABS_BRAIN_BUYER_WALLET_ID",
  fixedBrainFeeUsdc: BRAIN_TREASURY_FEE_USDC, // 0.000003
  endpointPath: "/api/paylabs/brain/run",
};

// ─── Macro-Node Configs ─────────────────────────────────────

export const MACRO_NODES: Record<MacroNodePhase, MacroNodeConfig> = {
  discovery_planner: {
    nodeType: "macro_node",
    nodeName: "discovery_planner",
    sellerWalletAddressEnv: "PAYLABS_NODE_DISCOVERY_PLANNER_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_NODE_DISCOVERY_PLANNER_BUYER_WALLET_ID",
    fixedNodeFeeUsdc: MACRO_NODE_FEE_USDC, // 0.000001 (base, allocation = base + children)
    endpointPath: "/api/paylabs/macro-nodes/discovery_planner/run",
    childServices: ["intent_planner", "query_builder", "signal_scout_basics"],
    tierLabel: "easy",
    brainPaymentMode: "circle_gateway_wallet_batched",
    childPaymentMode: "circle_gateway_wallet_batched_per_child_fallback",
    outputSummaryKey: "easy_summary",
  },
  payment_decision: {
    nodeType: "macro_node",
    nodeName: "payment_decision",
    sellerWalletAddressEnv: "PAYLABS_NODE_PAYMENT_DECISION_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_NODE_PAYMENT_DECISION_BUYER_WALLET_ID",
    fixedNodeFeeUsdc: MACRO_NODE_FEE_USDC, // 0.000001 (base)
    endpointPath: "/api/paylabs/macro-nodes/payment_decision/run",
    childServices: [
      "intent_matcher", "source_verifier", "value_allocator",
      "trust_verifier", "payment_decider",
    ],
    tierLabel: "normal",
    brainPaymentMode: "circle_gateway_wallet_batched",
    childPaymentMode: "circle_gateway_wallet_batched_per_child_fallback",
    outputSummaryKey: "normal_summary",
  },
  settlement_memory: {
    nodeType: "macro_node",
    nodeName: "settlement_memory",
    sellerWalletAddressEnv: "PAYLABS_NODE_SETTLEMENT_MEMORY_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_NODE_SETTLEMENT_MEMORY_BUYER_WALLET_ID",
    fixedNodeFeeUsdc: MACRO_NODE_FEE_USDC, // 0.000001 (base)
    endpointPath: "/api/paylabs/macro-nodes/settlement_memory/run",
    childServices: ["creator_attribution", "advanced_evidence_evaluator", "creator_payout_router"],
    tierLabel: "advanced",
    brainPaymentMode: "circle_gateway_wallet_batched",
    childPaymentMode: "circle_gateway_wallet_batched_per_child_fallback",
    outputSummaryKey: "advanced_summary",
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

/**
 * Get child budget for a macro-node (sum of child service fees).
 */
export function getMacroNodeChildBudgetUsdc(nodeName: MacroNodePhase): number {
  const config = MACRO_NODES[nodeName];
  return config.childServices.length * CHILD_SERVICE_FEE_USDC;
}

/**
 * Get tier-aware child services for a macro-node.
 * Normal settlement_memory: 2 children (creator_attribution + creator_payout_router)
 * Advanced settlement_memory: 3 children (+ advanced_evidence_evaluator)
 */
export function getMacroNodeChildServicesForTier(
  nodeName: MacroNodePhase,
  routeTier: "easy" | "normal" | "advanced",
): ServiceName[] {
  return [...getMacroNodeServicesForTier(nodeName, routeTier)];
}

/**
 * Get tier-aware allocation for a macro-node.
 * Includes child service budgets: base fee + (childCount * 0.000001).
 * Children are funded from this allocation, not as separate user cost.
 */
export function getMacroNodeAllocationUsdcForTier(
  nodeName: MacroNodePhase,
  routeTier: "easy" | "normal" | "advanced",
): number {
  const children = getMacroNodeServicesForTier(nodeName, routeTier);
  return MACRO_NODE_FEE_USDC + children.length * CHILD_SERVICE_FEE_USDC;
}

/**
 * Get static macro-node allocation: base fee + configured child budget.
 * Prefer getMacroNodeAllocationUsdcForTier() for tier-aware billing.
 */
export function getMacroNodeAllocationUsdc(nodeName: MacroNodePhase): number {
  const config = MACRO_NODES[nodeName];
  return MACRO_NODE_FEE_USDC + config.childServices.length * CHILD_SERVICE_FEE_USDC;
}

/**
 * Get all macro allocations for a given route tier.
 */
export function getTierMacroAllocations(routeTier: "easy" | "normal" | "advanced"): {
  macroNodes: MacroNodePhase[];
  allocations: Record<MacroNodePhase, number>;
  totalMacroAllocationUsdc: number;
} {
  const tierPhaseMap: Record<"easy" | "normal" | "advanced", MacroNodePhase[]> = {
    easy: ["discovery_planner"],
    normal: ["discovery_planner", "payment_decision", "settlement_memory"],
    advanced: ["discovery_planner", "payment_decision", "settlement_memory"],
  };
  const macroNodes = tierPhaseMap[routeTier];
  const allocations: Partial<Record<MacroNodePhase, number>> = {};
  let total = 0;
  for (const node of macroNodes) {
    const alloc = getMacroNodeAllocationUsdcForTier(node, routeTier);
    allocations[node] = alloc;
    total += alloc;
  }
  return {
    macroNodes,
    allocations: allocations as Record<MacroNodePhase, number>,
    totalMacroAllocationUsdc: total,
  };
}

/**
 * Get total user budget used for a tier (treasury + macro allocations).
 *
 * easy:     0.000003 + (0.000001 + 3*0.000001) = 0.000007
 * normal:   0.000003 + (0.000004 + 0.000006 + 0.000003) = 0.000016
 * advanced: 0.000003 + (0.000004 + 0.000006 + 0.000004) = 0.000017
 */
export function getTierUserBudgetUsedUsdc(routeTier: "easy" | "normal" | "advanced"): number {
  const { totalMacroAllocationUsdc } = getTierMacroAllocations(routeTier);
  return BRAIN_TREASURY_FEE_USDC + totalMacroAllocationUsdc;
}

/**
 * Get total child payment volume for a tier (sum of all children across macro nodes).
 */
export function getTierChildPaymentVolumeUsdc(routeTier: "easy" | "normal" | "advanced"): number {
  const { macroNodes } = getTierMacroAllocations(routeTier);
  let total = 0;
  for (const node of macroNodes) {
    const config = MACRO_NODES[node];
    total += config.childServices.length * CHILD_SERVICE_FEE_USDC;
  }
  return total;
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
