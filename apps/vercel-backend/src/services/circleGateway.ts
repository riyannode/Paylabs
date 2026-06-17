// Circle Gateway live service
// Balance queries, pending deposits, and on-chain deposit instructions
//
// Gateway REST /v1/balances is permissionless (no API key required).
// Deposit is an on-chain contract operation — this service returns instructions only.

import { config } from "../config.js";
import { isAddress } from "viem";

// Gateway domain IDs — must match the Circle Gateway API exactly
// Source: https://developers.circle.com/openapi/gateway.yaml
const GATEWAY_DOMAINS_TESTNET: Record<string, number> = {
  "Ethereum Sepolia": 0,
  "Avalanche Fuji": 1,
  "Optimism Sepolia": 2,
  "Arbitrum Sepolia": 3,
  "Solana Devnet": 5,
  "Base Sepolia": 6,
  "Polygon Amoy": 7,
  "Unichain Sepolia": 10,
  "Sonic Testnet": 13,
  "Worldchain Sepolia": 14,
  "Sei Atlantic": 16,
  "HyperEVM Testnet": 19,
  "ARC Testnet": 26,
};

const GATEWAY_DOMAINS_MAINNET: Record<string, number> = {
  Ethereum: 0,
  Avalanche: 1,
  Optimism: 2,
  Arbitrum: 3,
  Solana: 5,
  Base: 6,
  "Polygon PoS": 7,
  Unichain: 10,
  Sonic: 13,
  "World Chain": 14,
  Sei: 16,
  HyperEVM: 19,
};

// Gateway Wallet contract (same address on all testnet chains, same on all mainnet chains)
const GATEWAY_WALLET_TESTNET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const GATEWAY_WALLET_MAINNET = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";

// USDC on Arc Testnet (ERC-20, 6 decimals)
const USDC_ARC_TESTNET = "0x3600000000000000000000000000000000000000";

function getGatewayBaseUrl(): string {
  return config.circleGatewayTestnet
    ? "https://gateway-api-testnet.circle.com/v1"
    : "https://gateway-api.circle.com/v1";
}

function getGatewayDomains(): Record<string, number> {
  return config.circleGatewayTestnet
    ? GATEWAY_DOMAINS_TESTNET
    : GATEWAY_DOMAINS_MAINNET;
}

function getGatewayWalletAddress(): `0x${string}` {
  return (config.circleGatewayTestnet
    ? GATEWAY_WALLET_TESTNET
    : GATEWAY_WALLET_MAINNET) as `0x${string}`;
}

// --- Deposit instructions ---

export interface DepositInstructions {
  receiverAddress: string;
  chain: string;
  chainId: number;
  domain: number;
  usdcAddress: string;
  gatewayWallet: string;
  approve: {
    to: string;
    abi: string;
    functionName: string;
    args: string[];
  };
  deposit: {
    to: string;
    abi: string;
    functionName: string;
    args: string[];
  };
  note: string;
}

export function getDepositInstructions(): DepositInstructions {
  if (!isAddress(config.circleGatewayReceiverAddress)) {
    throw new GatewayConfigError(
      "CIRCLE_GATEWAY_RECEIVER_ADDRESS is not a valid Ethereum address"
    );
  }

  return {
    receiverAddress: config.circleGatewayReceiverAddress,
    chain: "ARC Testnet",
    chainId: config.arcChainId,
    domain: 26,
    usdcAddress: USDC_ARC_TESTNET,
    gatewayWallet: getGatewayWalletAddress(),
    approve: {
      to: USDC_ARC_TESTNET,
      abi: "function approve(address spender, uint256 amount) returns (bool)",
      functionName: "approve",
      args: [
        getGatewayWalletAddress(),
        "<amount in base units (6 decimals)>",
      ],
    },
    deposit: {
      to: getGatewayWalletAddress(),
      abi: "function deposit(address token, uint256 value)",
      functionName: "deposit",
      args: [USDC_ARC_TESTNET, "<same amount in base units>"],
    },
    note: "Execute approve first, then deposit. Both are on-chain transactions from the user's wallet. Backend does NOT hold private keys or execute transactions.",
  };
}

// --- Balance ---

export interface DomainBalance {
  domain: number;
  depositor: string;
  balance: string;
  pendingBatch: string;
}

export interface GatewayBalanceResult {
  token: string;
  balances: DomainBalance[];
  totalBalance: string;
}

export async function getBalance(
  walletAddress: string
): Promise<GatewayBalanceResult> {
  const domains = getGatewayDomains();
  const depositor = walletAddress.toLowerCase();
  const sources = Object.values(domains).map((domain) => ({
    domain,
    depositor,
  }));

  const response = await fetchGateway<{ token: string; balances: DomainBalance[] }>(
    "/balances",
    { token: "USDC", sources }
  );

  const total = response.balances.reduce(
    (sum, b) => sum + parseFloat(b.balance),
    0
  );

  return {
    token: response.token,
    balances: response.balances,
    totalBalance: total.toFixed(6),
  };
}

// --- Pending deposits ---

export interface PendingDeposit {
  domain: number;
  depositor: string;
  amount: string;
  status: string;
}

export async function getPendingDeposits(
  walletAddress: string
): Promise<PendingDeposit[]> {
  const domains = getGatewayDomains();
  const depositor = walletAddress.toLowerCase();
  const sources = Object.values(domains).map((domain) => ({
    domain,
    depositor,
  }));

  const response = await fetchGateway<{ token: string; deposits: PendingDeposit[] }>(
    "/deposits",
    { token: "USDC", sources }
  );

  return response.deposits;
}

// --- Config validation ---

export function validateGatewayConfig(): void {
  if (!isAddress(config.circleGatewayReceiverAddress)) {
    throw new GatewayConfigError(
      "CIRCLE_GATEWAY_RECEIVER_ADDRESS is not set or is not a valid Ethereum address"
    );
  }
}

// --- HTTP client ---

async function fetchGateway<T>(
  path: string,
  body: unknown
): Promise<T> {
  const url = `${getGatewayBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Gateway REST API is permissionless for /v1/balances and /v1/deposits
  // API key only needed for webhook management
  if (config.circleGatewayApiKey) {
    headers["Authorization"] = `Bearer ${config.circleGatewayApiKey}`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new GatewayApiError(
      `Gateway API ${res.status}: ${text}`,
      res.status
    );
  }

  return (await res.json()) as T;
}

// --- Errors ---

export class GatewayApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GatewayApiError";
    this.status = status;
  }
}

export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigError";
  }
}
