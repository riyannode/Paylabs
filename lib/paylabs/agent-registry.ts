/**
 * Agent Registry — 7 Paid Capability Agents
 *
 * These agents form the nanopayment audit lane for discovery runs.
 * Each agent has a fixed price of 0.000001 USDC per capability call.
 * Wallets are Circle DCW, resolved from env at runtime.
 *
 * This is SEPARATE from the 15-agent LangGraph which stays unchanged.
 */

export const AGENT_NANOPRICE_USDC = "0.000001";
export const AGENT_NANOPRICE_NUMBER = 0.000001;
export const AGENT_COUNT = 7;

export interface PaidAgentDef {
  name: string;
  capability: string;
  description: string;
  envWalletIdKey: string;
  envWalletAddressKey: string;
}

export const PAID_AGENTS: readonly PaidAgentDef[] = [
  {
    name: "tutor_intake",
    capability: "normalize_goal",
    description: "Clean user goal, suggest route tier",
    envWalletIdKey: "PAYLABS_AGENT_WALLET_ID_TUTOR_INTAKE",
    envWalletAddressKey: "PAYLABS_AGENT_WALLET_TUTOR_INTAKE",
  },
  {
    name: "intent_classifier",
    capability: "classify_intent",
    description: "Classify user intent and topic",
    envWalletIdKey: "PAYLABS_AGENT_WALLET_ID_INTENT_CLASSIFIER",
    envWalletAddressKey: "PAYLABS_AGENT_WALLET_INTENT_CLASSIFIER",
  },
  {
    name: "query_expander",
    capability: "expand_query",
    description: "Expand user query into search terms",
    envWalletIdKey: "PAYLABS_AGENT_WALLET_ID_QUERY_EXPANDER",
    envWalletAddressKey: "PAYLABS_AGENT_WALLET_QUERY_EXPANDER",
  },
  {
    name: "discovery_ranker",
    capability: "rank_active_sources",
    description: "Rank discovered sources by relevance",
    envWalletIdKey: "PAYLABS_AGENT_WALLET_ID_DISCOVERY_RANKER",
    envWalletAddressKey: "PAYLABS_AGENT_WALLET_DISCOVERY_RANKER",
  },
  {
    name: "source_quality_verifier",
    capability: "verify_source_quality",
    description: "Verify source content quality",
    envWalletIdKey: "PAYLABS_AGENT_WALLET_ID_SOURCE_QUALITY_VERIFIER",
    envWalletAddressKey: "PAYLABS_AGENT_WALLET_SOURCE_QUALITY_VERIFIER",
  },
  {
    name: "provenance_verifier",
    capability: "verify_provenance",
    description: "Verify source provenance and attribution",
    envWalletIdKey: "PAYLABS_AGENT_WALLET_ID_PROVENANCE_VERIFIER",
    envWalletAddressKey: "PAYLABS_AGENT_WALLET_PROVENANCE_VERIFIER",
  },
  {
    name: "attribution_auditor",
    capability: "audit_attribution",
    description: "Audit attribution chain and payout eligibility",
    envWalletIdKey: "PAYLABS_AGENT_WALLET_ID_ATTRIBUTION_AUDITOR",
    envWalletAddressKey: "PAYLABS_AGENT_WALLET_ATTRIBUTION_AUDITOR",
  },
] as const;

export const PAID_AGENT_NAMES = PAID_AGENTS.map((a) => a.name);
export type PaidAgentName = (typeof PAID_AGENTS)[number]["name"];

/**
 * Get agent definition by name.
 * Returns undefined if not a valid paid agent.
 */
export function getAgentDef(name: string): PaidAgentDef | undefined {
  return PAID_AGENTS.find((a) => a.name === name);
}

/**
 * Resolve agent wallet address from env.
 * Returns empty string if not configured — caller decides policy.
 */
export function resolveAgentWallet(name: string): string {
  const def = getAgentDef(name);
  if (!def) return "";
  return (process.env[def.envWalletAddressKey] || "").trim();
}

/**
 * Resolve agent wallet ID from env.
 */
export function resolveAgentWalletId(name: string): string {
  const def = getAgentDef(name);
  if (!def) return "";
  return (process.env[def.envWalletIdKey] || "").trim();
}

/**
 * Resolve treasury wallet from env.
 */
export function resolveTreasuryWallet(): {
  walletId: string;
  address: string;
} {
  return {
    walletId: (process.env.PAYLABS_TREASURY_WALLET_ID || "").trim(),
    address: (process.env.PAYLABS_TREASURY_WALLET_ADDRESS || "").trim(),
  };
}

/**
 * Resolve reserve wallet from env.
 */
export function resolveReserveWallet(): {
  walletId: string;
  address: string;
} {
  return {
    walletId: (process.env.PAYLABS_RESERVE_WALLET_ID || "").trim(),
    address: (process.env.PAYLABS_RESERVE_WALLET_ADDRESS || "").trim(),
  };
}

/**
 * Get the payer agent for a given agent in the execution chain.
 * Chain: treasury → tutor_intake → intent_classifier → query_expander →
 *        discovery_ranker → source_quality_verifier → provenance_verifier →
 *        attribution_auditor
 */
export function getPayerForAgent(agentName: PaidAgentName): string {
  switch (agentName) {
    case "tutor_intake":
      return "paylabs_treasury";
    case "intent_classifier":
      return "tutor_intake";
    case "query_expander":
      return "intent_classifier";
    case "discovery_ranker":
      return "query_expander";
    case "source_quality_verifier":
      return "discovery_ranker";
    case "provenance_verifier":
      return "source_quality_verifier";
    case "attribution_auditor":
      return "provenance_verifier";
    default:
      return "paylabs_treasury";
  }
}

/**
 * Check if all 7 agent wallets are configured.
 * Returns list of missing agent names.
 */
export function getMissingAgentWallets(): string[] {
  return PAID_AGENTS.filter(
    (a) => !resolveAgentWallet(a.name)
  ).map((a) => a.name);
}
