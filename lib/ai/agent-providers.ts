/**
 * Agent Provider Registry
 * Deterministic provider selection for agent-to-agent payments.
 * Provider must exist, be active, match service_type and route_tier, and be within price cap.
 *
 * RFB 03: Agent-to-Agent Nanopayment Networks
 */

import { supabaseAdmin } from "@/lib/supabase/server";
import { createHash } from "node:crypto";

const MAX_AGENT_SERVICE_PRICE_USDC = Number(
  process.env.PAYLABS_MAX_AGENT_SERVICE_PRICE_USDC || "0.001"
);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface AgentProvider {
  id: string;
  agent_id: string;
  service_type: string;
  endpoint_url: string;
  wallet_address: string;
  price_usdc: number;
  route_tiers_supported: string[];
  reputation_score: number;
  is_active: boolean;
}

/**
 * Resolve the runtime wallet address for a known provider agent.
 * For paylabs-source-verifier-v1: reads PAYLABS_SOURCE_VERIFIER_WALLET env.
 * Falls back to DB wallet_address only if it is a valid non-zero address.
 * Returns null if no valid wallet can be resolved.
 */
function resolveProviderWallet(agentId: string, dbWallet: string): string | null {
  // Per-provider env resolution
  let envWallet: string | undefined;
  if (agentId === "paylabs-source-verifier-v1") {
    envWallet = process.env.PAYLABS_SOURCE_VERIFIER_WALLET;
  }

  const wallet = envWallet || dbWallet;

  // Validate: must be 0x-prefixed, 42 chars, NOT zero address
  if (!wallet || !wallet.startsWith("0x") || wallet.length !== 42) return null;
  if (wallet.toLowerCase() === ZERO_ADDRESS) return null;

  return wallet;
}

/**
 * Get an active agent provider for a given service type and route tier.
 * Resolves wallet address from env at runtime — zero address is rejected.
 * Deterministic: returns first matching provider or null.
 */
export async function getActiveAgentProvider(
  serviceType: string,
  routeTier: string
): Promise<AgentProvider | null> {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_agent_providers")
    .select("*")
    .eq("service_type", serviceType)
    .eq("is_active", true)
    .contains("route_tiers_supported", [routeTier])
    .gt("price_usdc", 0)
    .order("reputation_score", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  // Price cap check
  if (data.price_usdc > MAX_AGENT_SERVICE_PRICE_USDC) return null;

  // Resolve wallet from env — reject zero address
  const resolvedWallet = resolveProviderWallet(data.agent_id, data.wallet_address);
  if (!resolvedWallet) return null;

  return { ...data, wallet_address: resolvedWallet } as AgentProvider;
}

/**
 * Validate that the agent service purchase is within budget.
 * Returns null if valid, error string if invalid.
 */
export function validateAgentServiceBudget(input: {
  budgetUsdc: number;
  alreadySpentUsdc: number;
  providerPrice: number;
}): string | null {
  const { budgetUsdc, alreadySpentUsdc, providerPrice } = input;
  if (providerPrice <= 0) return "Provider price must be > 0";
  if (providerPrice > MAX_AGENT_SERVICE_PRICE_USDC)
    return `Provider price ${providerPrice} exceeds max ${MAX_AGENT_SERVICE_PRICE_USDC}`;
  if (alreadySpentUsdc + providerPrice > budgetUsdc)
    return `Insufficient budget: need ${providerPrice}, have ${budgetUsdc - alreadySpentUsdc} remaining`;
  return null;
}

/**
 * Hash agent service input for audit trail.
 */
export function hashAgentServiceInput(input: unknown): string {
  const serialized = typeof input === "string" ? input : JSON.stringify(input);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}
