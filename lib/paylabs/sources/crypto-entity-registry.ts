/**
 * Crypto Entity Registry
 *
 * Expanded registry of crypto protocols, concepts, and aspect definitions.
 * Provides deterministic, LLM-free entity resolution and aspect extraction
 * for source relevance filtering and citation grounding.
 *
 * Used by: source-resolver, source-relevance, source-grounded-synthesis,
 *          query-builder, signal-scout
 *
 * No LLM. No secrets. Deterministic.
 */

// ─── Protocol Aliases ─────────────────────────────────────
// Canonical names → aliases (case-insensitive lookup)

export interface ProtocolAliasEntry {
  /** Canonical display name */
  canonical: string;
  /** All recognized aliases / alternate spellings */
  aliases: string[];
  /** Unambiguous aliases that may qualify source evidence */
  sourceAliases?: string[];
  /** Category tag */
  category: "lending" | "dex" | "cdp" | "amm";
  /** Brief description for context */
  description: string;
}

export const PROTOCOL_ALIASES: Record<string, ProtocolAliasEntry> = {
  aave: {
    canonical: "Aave",
    aliases: [
      "aave",
      "aave v2",
      "aave v3",
      "aave v4",
    ],
    category: "lending",
    description: "Decentralized non-codial lending/borrowing protocol with flash loans",
  },

  compound: {
    canonical: "Compound",
    aliases: [
      "compound",
      "compound finance",
      "compound v2",
      "compound v3",
      "compound v3 (Comet)",
      "comp",
      "comet",
    ],
    category: "lending",
    description: "Algorithmic money market protocol for lending and borrowing crypto assets",
  },

  makerDAO: {
    canonical: "MakerDAO",
    aliases: [
      "makerdao",
      "maker dao",
      "maker",
      "mkr",
      "dai",
      "sky protocol",
      "sky ecosystem",
      "sky money",
      "sky governance",
      "sds",
      "savings dai",
      "usds",
    ],
    category: "cdp",
    description: "Decentralized CDP-based stablecoin protocol (DAI/USDS), rebranded as Sky",
  },

  uniswap: {
    canonical: "Uniswap",
    aliases: [
      "uniswap",
      "uniswap v2",
      "uniswap v3",
      "uniswap v4",
      "uni",
      "uniswap labs",
      "uniswap governance",
    ],
    category: "dex",
    description: "Leading decentralized exchange using concentrated liquidity AMM",
  },

  curveFinance: {
    canonical: "Curve Finance",
    aliases: [
      "curve finance",
      "curve dex",
      "curve pools",
      "crv",
      "cvx",
      "convex",
      "convex finance",
      "curve wars",
    ],
    sourceAliases: [
      "Curve Finance",
      "curve.finance",
      "docs.curve.finance",
      "Curve pools",
      "Curve DEX",
    ],
    category: "amm",
    description: "DEX optimized for stablecoin/pegged asset swaps with low slippage",
  },

  balancer: {
    canonical: "Balancer",
    aliases: [
      "balancer",
      "balancer v2",
      "balancer v3",
      "bal",
      "aura",
      "aura finance",
      "beets",
      "beethoven x",
    ],
    category: "amm",
    description: "Programmable liquidity protocol with weighted pools and composable AMMs",
  },
};

// ─── Crypto Concept Entities ──────────────────────────────
// Broader crypto concepts, mechanisms, and risk categories

export interface CryptoConceptEntry {
  /** Canonical concept name */
  canonical: string;
  /** All recognized aliases */
  aliases: string[];
  /** Concept category */
  category:
    | "amm"
    | "mev"
    | "lending"
    | "oracle"
    | "fee_market"
    | "mining"
    | "consensus"
    | "risk";
  /** Brief description */
  description: string;
  /** Related aspect keys from ASPECT_DEFINITIONS */
  relatedAspects: string[];
}

export const CRYPTO_CONCEPT_ENTITIES: Record<string, CryptoConceptEntry> = {
  // ── AMM Concepts ──
  amm: {
    canonical: "AMM",
    aliases: [
      "amm",
      "automated market maker",
      "automated-market-maker",
      "liquidity pool",
      "liquidity pools",
      "liquidity pair",
      "liquidity pairs",
    ],
    category: "amm",
    description: "Automated market maker — algorithmic pricing for token swaps without order books",
    relatedAspects: [
      "constant_product",
      "concentrated_liquidity",
      "amm_design",
      "pricing_mechanism",
      "liquidity_model",
      "lp_fee_economics",
      "impermanent_loss",
    ],
  },

  // ── MEV Concepts ──
  mev: {
    canonical: "MEV",
    aliases: [
      "mev",
      "maximal extractable value",
      "miner extractable value",
      "sandwich attack",
      "sandwiching",
      "frontrunning",
      "front-running",
      "backrunning",
      "back-running",
      "arbitrage bot",
      "mev bot",
      "flashbots",
      "flashbots protect",
      "mev-share",
      "mev-boost",
      "mev boost",
      "mev-pbs",
      "builder apis",
      "proposer-builder separation",
    ],
    category: "mev",
    description: "Maximal extractable value — profit from transaction ordering, inclusion, and exclusion",
    relatedAspects: ["mev", "priority_fee", "base_fee", "validator_incentives"],
  },

  // ── Lending Concepts ──
  lending: {
    canonical: "Lending",
    aliases: [
      "lending",
      "borrowing",
      "lending protocol",
      "lending protocols",
      "money market",
      "money markets",
      "flash loan",
      "flash loans",
      "overcollateralization",
      "overcollateralized",
      "collateral factor",
      "health factor",
      "utilization rate",
    ],
    category: "lending",
    description: "Decentralized lending/borrowing with collateral, liquidation, and interest rate models",
    relatedAspects: [
      "collateral",
      "liquidation",
      "interest_rates",
      "lending_model",
      "protocol_risks",
    ],
  },

  // ── Oracle Concepts ──
  oracle: {
    canonical: "Oracle",
    aliases: [
      "oracle",
      "oracles",
      "price oracle",
      "price oracles",
      "chainlink",
      "chainlink oracle",
      "band protocol",
      "bandprotocol",
      "pyth",
      "pyth network",
      "twap",
      "time-weighted average price",
      "oracle manipulation",
      "oracle attack",
      "oracle feed",
      "price feed",
      "price feeds",
    ],
    category: "oracle",
    description: "On-chain price feeds connecting smart contracts to off-chain data",
    relatedAspects: ["oracle_risk"],
  },

  // ── Fee Market Concepts ──
  fee_market: {
    canonical: "Fee Market",
    aliases: [
      "fee market",
      "gas fee",
      "gas fees",
      "gas price",
      "gas limit",
      "eip-1559",
      "eip 1559",
      "base fee",
      "basefee",
      "priority fee",
      "priority fee",
      "max fee per gas",
      "maxPriorityFeePerGas",
      "priority_fee_per_gas",
      "dynamic base fee",
      "fee burning",
      "fee burn",
      "blob fee",
      "data fee",
    ],
    category: "fee_market",
    description: "Transaction fee mechanism — base fee burning + priority tips (EIP-1559)",
    relatedAspects: ["base_fee", "priority_fee", "congestion"],
  },

  // ── Mining / Consensus Concepts ──
  mining: {
    canonical: "Mining",
    aliases: [
      "mining",
      "proof of work",
      "pow",
      "hash rate",
      "hashrate",
      "difficulty",
      "block reward",
      "block subsidy",
      "asic",
      "asic miner",
      "gpu mining",
      "cpu mining",
      "solo mining",
      "pool mining",
      "mining pool",
      "mining pools",
      "stratum",
      "nonce",
      "share",
    ],
    category: "mining",
    description: "Proof-of-work mining — computational effort to produce blocks",
    relatedAspects: ["mining"],
  },

  consensus: {
    canonical: "Consensus",
    aliases: [
      "consensus",
      "consensus mechanism",
      "consensus mechanisms",
      "proof of stake",
      "pos",
      "proof-of-stake",
      "delegated proof of stake",
      "dpos",
      "proof of authority",
      "poa",
      "proof of history",
      "poh",
      "pbft",
      "tendermint",
      "casper",
      "gasper",
      "lmd-gasper",
      "finality",
      "block finality",
      "economic finality",
      "slashing",
      "slasher",
    ],
    category: "consensus",
    description: "Blockchain consensus mechanisms — how validators agree on block validity",
    relatedAspects: ["consensus", "validator_incentives"],
  },

  // ── Risk Concepts ──
  risks: {
    canonical: "Risks",
    aliases: [
      "impermanent loss",
      "il",
      "ilv",
      "liquidation",
      "liquidated",
      "smart contract risk",
      "smart contract exploit",
      "smart contract vulnerability",
      "hack",
      "exploit",
      "rug pull",
      "rugpull",
      "rug pull",
      "depeg",
      "depegging",
      "de-peg",
      "oracle manipulation",
      "oracle attack",
      "flash loan attack",
      "flash loan exploit",
      "bridge hack",
      "bridge exploit",
      "bridge vulnerability",
      "custody risk",
      "key management",
      "private key",
      "seed phrase",
      "hardware wallet",
      "cold storage",
      "risks",
      "major risks",
      "key risks",
      "protocol risks",
      "risk factors",
    ],
    category: "risk",
    description: "DeFi and crypto risk categories — smart contract, oracle, bridge, custody",
    relatedAspects: [
      "impermanent_loss",
      "oracle_risk",
      "custody_risk",
      "bridge_risk",
      "liquidation",
    ],
  },
};

// ─── Aspect Definitions ───────────────────────────────────
// Structured definitions of what "aspects" mean for entity resolution

export interface AspectDefinition {
  /** Canonical aspect key */
  key: string;
  /** Human-readable label */
  label: string;
  /** Which category this aspect belongs to */
  category:
    | "protocol_mechanism"
    | "network_economics"
    | "amm_mechanics"
    | "risk_factors"
    | "mining_consensus";
  /** Keywords that indicate this aspect is being asked about */
  signalTerms: string[];
  /** Which protocols this aspect is most relevant to */
  relevantProtocols: string[];
  /** Which concepts this aspect is most relevant to */
  relevantConcepts: string[];
  /** Brief description for documentation */
  description: string;
}

export const ASPECT_DEFINITIONS: Record<string, AspectDefinition> = {
  // ── Protocol Mechanism Aspects ──
  purpose: {
    key: "purpose",
    label: "Purpose",
    category: "protocol_mechanism",
    signalTerms: [
      "what is",
      "purpose",
      "goal",
      "mission",
      "objective",
      "designed for",
      "used for",
      "how does it work",
    ],
    relevantProtocols: ["aave", "compound", "makerDAO", "uniswap", "curveFinance", "balancer"],
    relevantConcepts: ["amm", "lending", "consensus"],
    description: "What a protocol or concept is designed to do",
  },

  consensus: {
    key: "consensus",
    label: "Consensus Mechanism",
    category: "network_economics",
    signalTerms: [
      "consensus",
      "proof of stake",
      "proof of work",
      "pos",
      "pow",
      "finality",
      "validators",
      "slashing",
    ],
    relevantProtocols: [],
    relevantConcepts: ["consensus", "mining"],
    description: "How the network achieves agreement on block validity",
  },

  lending_model: {
    key: "lending_model",
    label: "Lending Model",
    category: "protocol_mechanism",
    signalTerms: [
      "lending model",
      "lending models",
      "borrowing model",
      "borrowing models",
      "lending mechanism",
      "lending mechanisms",
      "money market model",
      "market model",
    ],
    relevantProtocols: ["aave", "compound", "makerDAO"],
    relevantConcepts: ["lending"],
    description: "How a protocol structures lending and borrowing markets",
  },

  collateral: {
    key: "collateral",
    label: "Collateral",
    category: "protocol_mechanism",
    signalTerms: [
      "collateral",
      "collateralization",
      "collateral factor",
      "collateral type",
      "collateral ratio",
      "deposit",
      "pledge",
      "lock",
    ],
    relevantProtocols: ["aave", "compound", "makerDAO"],
    relevantConcepts: ["lending"],
    description: "Assets deposited as security for borrowing or minting",
  },

  liquidation: {
    key: "liquidation",
    label: "Liquidation",
    category: "risk_factors",
    signalTerms: [
      "liquidation",
      "liquidated",
      "liquidate",
      "health factor",
      "collateral ratio",
      "undercollateralized",
      "margin call",
    ],
    relevantProtocols: ["aave", "compound", "makerDAO"],
    relevantConcepts: ["lending", "risks"],
    description: "Forced closure of positions when collateral falls below threshold",
  },

  interest_rates: {
    key: "interest_rates",
    label: "Interest Rates",
    category: "protocol_mechanism",
    signalTerms: [
      "interest rate",
      "interest rates",
      "borrow rate",
      "supply rate",
      "lending rate",
      "apy",
      "apr",
      "utilization",
      "rate model",
      "kink",
    ],
    relevantProtocols: ["aave", "compound", "makerDAO"],
    relevantConcepts: ["lending"],
    description: "Dynamic rates for borrowing/lending based on supply and demand",
  },

  protocol_risks: {
    key: "protocol_risks",
    label: "Protocol Risks",
    category: "risk_factors",
    signalTerms: [
      "major risk",
      "major risks",
      "key risk",
      "key risks",
      "protocol risk",
      "protocol risks",
      "risk profile",
      "risk factors",
      "lending risk",
      "lending risks",
    ],
    relevantProtocols: ["aave", "compound", "makerDAO"],
    relevantConcepts: ["lending", "risks"],
    description: "Broad protocol risk factors without requiring individual risk subtypes",
  },

  governance: {
    key: "governance",
    label: "Governance",
    category: "protocol_mechanism",
    signalTerms: [
      "governance",
      "dao",
      "vote",
      "voting",
      "proposal",
      "token holder",
      "delegate",
      "governance token",
      "on-chain vote",
      "off-chain vote",
    ],
    relevantProtocols: ["aave", "compound", "makerDAO", "uniswap", "curveFinance", "balancer"],
    relevantConcepts: [],
    description: "Decentralized decision-making through token voting",
  },

  // ── Network Economics Aspects ──
  base_fee: {
    key: "base_fee",
    label: "Base Fee",
    category: "network_economics",
    signalTerms: [
      "base fee",
      "basefee",
      "eip-1559",
      "eip 1559",
      "fee burning",
      "fee burn",
      "burned",
      "deflationary",
    ],
    relevantProtocols: [],
    relevantConcepts: ["fee_market"],
    description: "Algorithmically adjusted minimum fee per gas unit, burned on inclusion",
  },

  priority_fee: {
    key: "priority_fee",
    label: "Priority Fee",
    category: "network_economics",
    signalTerms: [
      "priority fee",
      "tip",
      "tips",
      "max priority fee",
      "priority fee per gas",
      "incentive",
      "validator tip",
    ],
    relevantProtocols: [],
    relevantConcepts: ["fee_market", "mev"],
    description: "Optional tip paid to validators for transaction inclusion priority",
  },

  congestion: {
    key: "congestion",
    label: "Congestion",
    category: "network_economics",
    signalTerms: [
      "congestion",
      "network congestion",
      "gas spike",
      "gas price spike",
      "high gas",
      "slow transactions",
      "mempool",
      "pending transactions",
      "backlog",
    ],
    relevantProtocols: [],
    relevantConcepts: ["fee_market"],
    description: "Network demand exceeding capacity, driving up fees and confirmation times",
  },

  validator_incentives: {
    key: "validator_incentives",
    label: "Validator Incentives",
    category: "network_economics",
    signalTerms: [
      "validator rewards",
      "staking rewards",
      "validator income",
      "proposer reward",
      "attestation reward",
      "mev reward",
      "priority fees",
      "inclusion reward",
    ],
    relevantProtocols: [],
    relevantConcepts: ["consensus", "mev"],
    description: "Revenue streams for block producers — consensus rewards + MEV + tips",
  },

  mev: {
    key: "mev",
    label: "MEV",
    category: "network_economics",
    signalTerms: [
      "mev",
      "maximal extractable value",
      "sandwich",
      "frontrun",
      "backrun",
      "arbitrage bot",
      "flashbots",
      "mev-boost",
      "mev share",
      "transaction ordering",
    ],
    relevantProtocols: [],
    relevantConcepts: ["mev", "fee_market"],
    description: "Profit extracted from transaction ordering, inclusion, and exclusion",
  },

  // ── AMM Mechanics Aspects ──
  constant_product: {
    key: "constant_product",
    label: "Constant Product Formula",
    category: "amm_mechanics",
    signalTerms: [
      "constant product",
      "x * y = k",
      "xy=k",
      "constant product formula",
      "automated market maker",
      "amm formula",
      "price impact",
      "slippage",
    ],
    relevantProtocols: ["uniswap", "curveFinance"],
    relevantConcepts: ["amm"],
    description: "x * y = k pricing formula where reserves multiply to a constant",
  },

  concentrated_liquidity: {
    key: "concentrated_liquidity",
    label: "Concentrated Liquidity",
    category: "amm_mechanics",
    signalTerms: [
      "concentrated liquidity",
      "fee tiers",
      "tick",
      "ticks",
      "price range",
      "range orders",
      "capital efficiency",
      "liquidity concentration",
      "virtual reserves",
    ],
    relevantProtocols: ["uniswap", "curveFinance"],
    relevantConcepts: ["amm"],
    description: "LP positions bound to specific price ranges for higher capital efficiency",
  },

  amm_design: {
    key: "amm_design",
    label: "AMM Design",
    category: "amm_mechanics",
    signalTerms: [
      "amm design",
      "amm designs",
      "amm model",
      "amm models",
      "amm architecture",
      "automated market maker design",
      "automated market maker designs",
      "market maker design",
    ],
    relevantProtocols: ["uniswap", "curveFinance", "balancer"],
    relevantConcepts: ["amm"],
    description: "The architecture and design model used by an automated market maker",
  },

  pricing_mechanism: {
    key: "pricing_mechanism",
    label: "Pricing Mechanism",
    category: "amm_mechanics",
    signalTerms: [
      "pricing mechanism",
      "pricing mechanisms",
      "pricing model",
      "pricing models",
      "pricing formula",
      "pricing formulas",
      "swap pricing",
      "pool pricing",
      "price function",
    ],
    relevantProtocols: ["uniswap", "curveFinance", "balancer"],
    relevantConcepts: ["amm"],
    description: "How an AMM calculates swap prices and price impact",
  },

  liquidity_model: {
    key: "liquidity_model",
    label: "Liquidity Model",
    category: "amm_mechanics",
    signalTerms: [
      "liquidity model",
      "liquidity models",
      "liquidity design",
      "liquidity designs",
      "liquidity structure",
      "liquidity structures",
      "liquidity provision model",
      "pool design",
      "pool designs",
    ],
    relevantProtocols: ["uniswap", "curveFinance", "balancer"],
    relevantConcepts: ["amm"],
    description: "How liquidity is organized, supplied, and distributed across AMM pools",
  },

  lp_fee_economics: {
    key: "lp_fee_economics",
    label: "LP Fee Economics",
    category: "amm_mechanics",
    signalTerms: [
      "lp fee",
      "lp fees",
      "lp fee economics",
      "liquidity provider fee",
      "liquidity provider fees",
      "fee economics",
      "fee revenue",
      "trading fee revenue",
      "fee distribution",
      "liquidity provider revenue",
    ],
    relevantProtocols: ["uniswap", "curveFinance", "balancer"],
    relevantConcepts: ["amm"],
    description: "How trading fees generate and distribute revenue to liquidity providers",
  },

  impermanent_loss: {
    key: "impermanent_loss",
    label: "Impermanent Loss",
    category: "risk_factors",
    signalTerms: [
      "impermanent loss",
      "il",
      "price divergence",
      "liquidity provision risk",
      "lp loss",
      "divergence loss",
    ],
    relevantProtocols: ["uniswap", "curveFinance", "balancer"],
    relevantConcepts: ["amm", "risks"],
    description: "Loss from holding LP tokens vs simply holding underlying assets",
  },

  // ── Risk Aspects ──
  oracle_risk: {
    key: "oracle_risk",
    label: "Oracle Risk",
    category: "risk_factors",
    signalTerms: [
      "oracle risk",
      "oracle manipulation",
      "oracle attack",
      "price manipulation",
      "price feed attack",
      "stale price",
      "oracle failure",
    ],
    relevantProtocols: ["aave", "compound", "makerDAO"],
    relevantConcepts: ["oracle", "risks"],
    description: "Risk that price feeds return manipulated or stale data",
  },

  custody_risk: {
    key: "custody_risk",
    label: "Custody Risk",
    category: "risk_factors",
    signalTerms: [
      "custody",
      "custody risk",
      "private key",
      "key management",
      "multisig",
      "multi-sig",
      "cold storage",
      "hardware wallet",
      "hot wallet",
      "cex custody",
      "exchange custody",
    ],
    relevantProtocols: [],
    relevantConcepts: ["risks"],
    description: "Risk from how private keys and assets are stored and controlled",
  },

  bridge_risk: {
    key: "bridge_risk",
    label: "Bridge Risk",
    category: "risk_factors",
    signalTerms: [
      "bridge",
      "bridge risk",
      "cross-chain bridge",
      "bridge hack",
      "bridge exploit",
      "wrapped token",
      "bridged asset",
      "lock and mint",
      "burn and mint",
    ],
    relevantProtocols: [],
    relevantConcepts: ["risks"],
    description: "Risk from cross-chain bridges — exploits, depegs, and lock failures",
  },

  // ── Mining / Consensus Aspects ──
  mining: {
    key: "mining",
    label: "Mining",
    category: "mining_consensus",
    signalTerms: [
      "mining",
      "miner",
      "hash rate",
      "hashrate",
      "difficulty",
      "block reward",
      "asic",
      "gpu mining",
      "mining pool",
      "proof of work",
    ],
    relevantProtocols: [],
    relevantConcepts: ["mining"],
    description: "Proof-of-work block production through computational effort",
  },
};

// ─── Requested Aspects Type ───────────────────────────────

/** Represents a user's requested aspect of a crypto entity */
export interface RequestedAspect {
  /** The aspect key (e.g., "liquidation", "collateral") */
  aspectKey: string;
  /** The aspect definition */
  definition: AspectDefinition;
  /** The original text that triggered this aspect */
  sourceText: string;
  /** Confidence that this aspect was requested (0-1) */
  confidence: number;
}

/** Type guard: check if a string is a valid aspect key */
export function isValidAspectKey(key: string): key is keyof typeof ASPECT_DEFINITIONS {
  return key in ASPECT_DEFINITIONS;
}

// ─── Extract Requested Aspects ────────────────────────────
// Deterministic extraction from query text — no LLM

/**
 * Extract requested aspects from a query or normalized goal.
 * Scans for signal terms across all aspect definitions.
 * Returns matched aspects sorted by relevance (signal term count).
 */
export function extractRequestedAspects(
  text: string,
  options?: { minConfidence?: number }
): RequestedAspect[] {
  const minConfidence = options?.minConfidence ?? 0.3;
  const results: RequestedAspect[] = [];
  const seen = new Set<string>();

  function boundaryMatch(term: string): boolean {
    const normalized = text.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
    const termNorm = term.toLowerCase().trim();
    if (!termNorm) return false;
    // For short tokens (<=3 chars), require word boundaries
    if (termNorm.length <= 3) {
      const escaped = termNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(normalized);
    }
    // For longer terms, use phrase matching with surrounding spaces
    const haystack = ` ${normalized} `;
    const needle = ` ${termNorm} `;
    return haystack.includes(needle);
  }

  for (const [key, def] of Object.entries(ASPECT_DEFINITIONS)) {
    if (seen.has(key)) continue;

    let matchCount = 0;
    let matchedTerm = "";

    for (const term of def.signalTerms) {
      if (boundaryMatch(term)) {
        matchCount++;
        matchedTerm = term;
      }
    }

    if (matchCount === 0) continue;

    // Confidence scales with signal term density, capped at 1.0
    const confidence = Math.min(1.0, matchCount * 0.35);

    if (confidence < minConfidence) continue;

    results.push({
      aspectKey: key,
      definition: def,
      sourceText: matchedTerm,
      confidence,
    });

    seen.add(key);
  }

  // Sort by confidence descending
  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

// ─── ALL_ALIASES Merged Lookup ────────────────────────────
// Flat case-insensitive map: alias → canonical name + entity type

export type EntityType = "protocol" | "concept";

interface AliasLookupEntry {
  /** Canonical name */
  canonical: string;
  /** Entity type */
  entityType: EntityType;
  /** The parent record key in the original registry */
  registryKey: string;
}

/**
 * Merged lookup of all protocol aliases and concept aliases.
 * Keyed by lowercase alias. Use resolveContextualEntity() for
 * full resolution with contextual disambiguation.
 */
export const ALL_ALIASES: Map<string, AliasLookupEntry> = new Map();

// ─── Contextual Short Tokens ──────────────────────────────
// Ambiguous short tokens that need context to resolve

/** Tokens that are too short/ambiguous to match without surrounding context */
export const CONTEXTUAL_SHORT_TOKENS: Record<
  string,
  Array<{ canonical: string; entityType: EntityType; disambiguation: string }>
> = {
  // "comp" could be Compound or compression
  comp: [
    {
      canonical: "Compound",
      entityType: "protocol",
      disambiguation: "DeFi lending when context mentions lending, borrowing, collateral, interest",
    },
  ],
  // "crv" is clearly Curve
  crv: [
    {
      canonical: "Curve Finance",
      entityType: "protocol",
      disambiguation: "Curve Finance reward token",
    },
  ],
  // "curve" is ambiguous in ordinary English; resolve it only in DeFi/DEX context
  curve: [
    {
      canonical: "Curve Finance",
      entityType: "protocol",
      disambiguation: "Curve Finance when context mentions uniswap, decentralized exchange, dex, amm, automated market maker, liquidity, liquidity pool, lp, swap, stablecoin, stableswap",
    },
  ],
  // "cvx" is Convex (related to Curve)
  cvx: [
    {
      canonical: "Convex Finance",
      entityType: "protocol",
      disambiguation: "Convex Finance — Curve yield optimizer",
    },
  ],
  // "bal" is Balancer
  bal: [
    {
      canonical: "Balancer",
      entityType: "protocol",
      disambiguation: "Balancer governance token",
    },
  ],
  // "uni" is Uniswap
  uni: [
    {
      canonical: "Uniswap",
      entityType: "protocol",
      disambiguation: "Uniswap governance token",
    },
  ],
  // "mkr" is MakerDAO
  mkr: [
    {
      canonical: "MakerDAO",
      entityType: "protocol",
      disambiguation: "MakerDAO governance token",
    },
  ],
  // "dai" is DAI (MakerDAO)
  dai: [
    {
      canonical: "MakerDAO",
      entityType: "protocol",
      disambiguation: "DAI stablecoin from MakerDAO/Sky",
    },
  ],
  // "il" could be impermanent loss or other things
  il: [
    {
      canonical: "Impermanent Loss",
      entityType: "concept",
      disambiguation: "Impermanent Loss when context mentions liquidity, pools, LP tokens",
    },
  ],
  // "pos" is Proof of Stake
  pos: [
    {
      canonical: "Proof of Stake",
      entityType: "concept",
      disambiguation: "Consensus mechanism when context mentions validators, staking, consensus",
    },
  ],
  // "pow" is Proof of Work
  pow: [
    {
      canonical: "Proof of Work",
      entityType: "concept",
      disambiguation: "Consensus mechanism when context mentions mining, hash rate, ASICs",
    },
  ],
  // "dex" is decentralized exchange
  dex: [
    {
      canonical: "Decentralized Exchange",
      entityType: "concept",
      disambiguation: "DEX when context mentions swaps, trading, liquidity, AMM",
    },
  ],
  // "cdp" is collateralized debt position (MakerDAO)
  cdp: [
    {
      canonical: "Collateralized Debt Position",
      entityType: "concept",
      disambiguation: "CDP when context mentions MakerDAO, DAI, vaults, collateral",
    },
  ],
  // "lp" is liquidity provider
  lp: [
    {
      canonical: "Liquidity Provider",
      entityType: "concept",
      disambiguation: "LP tokens when context mentions pools, yield, impermanent loss",
    },
  ],
};

// ─── ALL_ALIASES Population (after CONTEXTUAL_SHORT_TOKENS declaration) ───
// Exclude keys that appear in CONTEXTUAL_SHORT_TOKENS — those need
// contextual disambiguation in resolveContextualEntity(), not unconditional
// alias resolution.
const contextualKeys = new Set(Object.keys(CONTEXTUAL_SHORT_TOKENS));

// Populate from PROTOCOL_ALIASES
for (const [key, entry] of Object.entries(PROTOCOL_ALIASES)) {
  for (const alias of entry.aliases) {
    const aliasLower = alias.toLowerCase();
    if (contextualKeys.has(aliasLower)) continue;
    ALL_ALIASES.set(aliasLower, {
      canonical: entry.canonical,
      entityType: "protocol",
      registryKey: key,
    });
  }
}

// Populate from CRYPTO_CONCEPT_ENTITIES
for (const [key, entry] of Object.entries(CRYPTO_CONCEPT_ENTITIES)) {
  for (const alias of entry.aliases) {
    const aliasLower = alias.toLowerCase();
    if (contextualKeys.has(aliasLower)) continue;
    ALL_ALIASES.set(aliasLower, {
      canonical: entry.canonical,
      entityType: "concept",
      registryKey: key,
    });
  }
}

// ─── Resolve Contextual Entity
// Deterministic entity resolution with context awareness

export interface ResolvedEntity {
  /** Canonical name */
  canonical: string;
  /** Entity type */
  entityType: EntityType;
  /** Source of resolution: "alias" | "contextual" | "exact" */
  resolutionSource: "alias" | "contextual" | "exact";
  /** The matched term */
  matchedTerm: string;
  /** Disambiguation note (for contextual matches) */
  disambiguation?: string;
}

/**
 * Resolve an entity mention to its canonical form.
 * Uses exact match → alias lookup → contextual short token disambiguation.
 *
 * For contextual tokens, examines surrounding text to determine the best match.
 * Returns null if no match found.
 *
 * No LLM. Pure deterministic string matching.
 */
export function resolveContextualEntity(
  term: string,
  surroundingText?: string
): ResolvedEntity | null {
  const lower = term.toLowerCase().trim();
  if (!lower) return null;

  // 1. Exact match in ALL_ALIASES
  const aliasMatch = ALL_ALIASES.get(lower);
  if (aliasMatch) {
    return {
      canonical: aliasMatch.canonical,
      entityType: aliasMatch.entityType,
      resolutionSource: "alias",
      matchedTerm: term,
    };
  }

  // 2. Check if it's a contextual short token
  const contextualOptions = CONTEXTUAL_SHORT_TOKENS[lower];
  if (contextualOptions && contextualOptions.length > 0) {
    if (!surroundingText) {
      // No context — fail closed. Bare ambiguous tokens must not resolve
      // to an entity without contextual signal.
      return null;
    }

    // Examine surrounding text for contextual signals
    const ctxLower = surroundingText.toLowerCase();

    for (const option of contextualOptions) {
      const disambiguationLower = option.disambiguation.toLowerCase();

      // Extract key signal words from disambiguation string
      // Format: "Entity — context signals: word1, word2, word3"
      const signalWords = disambiguationLower
        .split(/when context mentions|when context|signals?[:]/i)
        .pop()
        ?.split(/[,;]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 1) ?? [];

      // Check if any signal words appear in surrounding text
      const hasSignal = signalWords.some((word) => ctxLower.includes(word));
      if (hasSignal) {
        return {
          canonical: option.canonical,
          entityType: option.entityType,
          resolutionSource: "contextual",
          matchedTerm: term,
          disambiguation: option.disambiguation,
        };
      }
    }

    // No contextual signal found — fail closed.
    // Return null rather than guessing, so bare ambiguous tokens
    // (e.g. "comp" without DeFi context) do not resolve to an entity.
    return null;
  }

  // 3. No match
  return null;
}

/**
 * Return only unambiguous protocol identities that may qualify source evidence.
 * Contextual aliases such as raw "curve" are deliberately excluded.
 */
export function getProtocolEvidenceAliases(protocolKeyOrCanonical: string): string[] {
  const normalized = protocolKeyOrCanonical.toLowerCase().trim();
  const entry = PROTOCOL_ALIASES[protocolKeyOrCanonical]
    || Object.values(PROTOCOL_ALIASES).find((candidate) => candidate.canonical.toLowerCase() === normalized);
  if (!entry) return [];

  const aliases = entry.sourceAliases || [
    entry.canonical,
    ...entry.aliases.filter((alias) => !contextualKeys.has(alias.toLowerCase())),
  ];
  return [...new Set(aliases.map((alias) => alias.trim()).filter(Boolean))];
}

// ─── Convenience: Get all protocol canonical names ────────

/** Get all canonical protocol names */
export function getAllProtocolNames(): string[] {
  return Object.values(PROTOCOL_ALIASES).map((e) => e.canonical);
}

/** Get all canonical concept names */
export function getAllConceptNames(): string[] {
  return Object.values(CRYPTO_CONCEPT_ENTITIES).map((e) => e.canonical);
}

/** Get all aspect keys */
export function getAllAspectKeys(): string[] {
  return Object.keys(ASPECT_DEFINITIONS);
}

/**
 * Find which aspects are most relevant to a given protocol.
 * Returns aspect keys sorted by relevance (number of matching terms).
 */
export function findRelevantAspects(
  protocolKey: string,
  text: string
): RequestedAspect[] {
  const protocol = PROTOCOL_ALIASES[protocolKey];
  if (!protocol) return [];

  return extractRequestedAspects(text).filter((ra) =>
    ra.definition.relevantProtocols.includes(protocolKey)
  );
}

/**
 * Find which aspects are most relevant to a given concept.
 * Returns aspect keys sorted by relevance.
 */
export function findConceptRelevantAspects(
  conceptKey: string,
  text: string
): RequestedAspect[] {
  const concept = CRYPTO_CONCEPT_ENTITIES[conceptKey];
  if (!concept) return [];

  return extractRequestedAspects(text).filter((ra) =>
    ra.definition.relevantConcepts.includes(conceptKey)
  );
}
