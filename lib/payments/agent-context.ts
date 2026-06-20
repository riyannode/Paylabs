/**
 * Agent Context Signing & Verification
 *
 * Each paid agent capability call carries a signed context in
 * the x-paylabs-agent-context header.
 *
 * The context binds:
 *   - which agent is being called
 *   - what capability it provides
 *   - the exact price (0.000001 USDC)
 *   - the wallet addresses (payer + payee)
 *   - the receipt link
 *   - TTL (5 minutes)
 *
 * Signing uses HMAC-SHA256 with PAYLABS_HMAC_SECRET.
 * No private keys, no LLM signing.
 */

import { createHmac, randomUUID } from "node:crypto";
import { AGENT_NANOPRICE_USDC, type PaidAgentName, getAgentDef, resolveAgentWallet } from "@/lib/paylabs/agent-registry";
import type { ExternalRouteTier } from "@/lib/paylabs/route-tier";

// ─── Types ─────────────────────────────────────────────────────

export interface AgentContextPayload {
  run_id: string;
  agent_call_id: string;
  payer_agent: string;
  payee_agent: string;
  agent_name: string;
  capability: string;
  route_tier: string;
  payment_route: string;
  settlement_mode: "nano" | "batch";
  payment_kind: string;
  amount_usdc: string;
  payer_wallet: string;
  payee_wallet: string;
  receipt_id: string;
  receipt_url: string;
  expires_at: string;
  sig: string;
}

export interface CreateAgentContextInput {
  runId: string;
  agentName: PaidAgentName;
  routeTier: ExternalRouteTier;
  settlementMode: "nano" | "batch";
  payerWallet: string;
  receiptId: string;
}

export interface VerifyResult {
  valid: boolean;
  payload?: AgentContextPayload;
  error?: string;
}

// ─── Constants ─────────────────────────────────────────────────

const CONTEXT_TTL_MS = 5 * 60 * 1000; // 5 minutes

const SIGN_FIELDS = [
  "run_id",
  "agent_call_id",
  "agent_name",
  "capability",
  "route_tier",
  "settlement_mode",
  "amount_usdc",
  "payer_wallet",
  "payee_wallet",
  "receipt_id",
  "expires_at",
] as const;

// ─── Signing ───────────────────────────────────────────────────

function getHmacSecret(): string {
  const secret = process.env.PAYLABS_HMAC_SECRET || "";
  if (!secret) {
    throw new Error("PAYLABS_HMAC_SECRET not configured");
  }
  return secret;
}

function computeSignature(
  payload: Omit<AgentContextPayload, "sig">,
  secret: string
): string {
  const message = SIGN_FIELDS.map((f) => `${f}:${payload[f]}`).join("|");
  return createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * Create a signed agent context for a paid capability call.
 *
 * Returns the full context payload with signature, ready to be
 * serialized into the x-paylabs-agent-context header.
 */
export function createAgentContext(
  input: CreateAgentContextInput
): AgentContextPayload {
  const secret = getHmacSecret();
  const def = getAgentDef(input.agentName);
  if (!def) {
    throw new Error(`Unknown paid agent: ${input.agentName}`);
  }

  const payeeWallet = resolveAgentWallet(input.agentName);
  const agentCallId = randomUUID();
  const expiresAt = new Date(Date.now() + CONTEXT_TTL_MS).toISOString();
  const baseUrl = process.env.NEXT_PUBLIC_PAYLABS_APP_URL || "";
  const receiptUrl = `/api/paylabs/receipts/${input.receiptId}`;

  const unsigned: Omit<AgentContextPayload, "sig"> = {
    run_id: input.runId,
    agent_call_id: agentCallId,
    payer_agent: "paylabs_treasury",
    payee_agent: input.agentName,
    agent_name: input.agentName,
    capability: def.capability,
    route_tier: input.routeTier,
    payment_route: "circle_gateway_x402",
    settlement_mode: input.settlementMode,
    payment_kind: "agent_capability_fee",
    amount_usdc: AGENT_NANOPRICE_USDC,
    payer_wallet: input.payerWallet,
    payee_wallet: payeeWallet,
    receipt_id: input.receiptId,
    receipt_url: receiptUrl,
    expires_at: expiresAt,
  };

  const sig = computeSignature(unsigned, secret);

  return { ...unsigned, sig };
}

// ─── Verification ──────────────────────────────────────────────

/**
 * Verify a signed agent context from the x-paylabs-agent-context header.
 *
 * Checks:
 * 1. Signature is valid HMAC-SHA256
 * 2. Context is not expired (expires_at > now)
 * 3. amount_usdc == 0.000001
 * 4. agent_name matches expected agent
 * 5. payee_wallet matches resolved wallet for agent
 *
 * Returns valid=false with error reason if any check fails.
 */
export function verifyAgentContext(
  raw: string,
  expectedAgentName: string
): VerifyResult {
  let payload: AgentContextPayload;
  try {
    payload = JSON.parse(raw) as AgentContextPayload;
  } catch {
    return { valid: false, error: "Invalid JSON in agent context" };
  }

  // 1. Check required fields
  for (const field of SIGN_FIELDS) {
    if (!payload[field]) {
      return { valid: false, error: `Missing field: ${field}` };
    }
  }

  // 2. Verify signature
  const secret = process.env.PAYLABS_HMAC_SECRET || "";
  if (!secret) {
    return { valid: false, error: "PAYLABS_HMAC_SECRET not configured" };
  }

  const { sig, ...unsigned } = payload;
  const expectedSig = computeSignature(unsigned as Omit<AgentContextPayload, "sig">, secret);
  if (sig !== expectedSig) {
    return { valid: false, error: "Invalid signature" };
  }

  // 3. Check expiry
  const expiresAt = new Date(payload.expires_at).getTime();
  if (Date.now() > expiresAt) {
    return { valid: false, error: "Agent context expired" };
  }

  // 4. Check agent name matches
  if (payload.agent_name !== expectedAgentName) {
    return {
      valid: false,
      error: `Agent name mismatch: expected ${expectedAgentName}, got ${payload.agent_name}`,
    };
  }

  // 5. Check fixed price
  if (payload.amount_usdc !== AGENT_NANOPRICE_USDC) {
    return {
      valid: false,
      error: `Invalid price: expected ${AGENT_NANOPRICE_USDC}, got ${payload.amount_usdc}`,
    };
  }

  // 6. Check payee wallet matches resolved wallet
  const resolvedWallet = resolveAgentWallet(expectedAgentName);
  if (resolvedWallet && payload.payee_wallet.toLowerCase() !== resolvedWallet.toLowerCase()) {
    return {
      valid: false,
      error: `Wallet mismatch for ${expectedAgentName}`,
    };
  }

  return { valid: true, payload };
}

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Serialize agent context to JSON string for header value.
 */
export function serializeAgentContext(payload: AgentContextPayload): string {
  return JSON.stringify(payload);
}

/**
 * Parse agent context from header string.
 * Returns null if invalid JSON.
 */
export function parseAgentContext(raw: string): AgentContextPayload | null {
  try {
    return JSON.parse(raw) as AgentContextPayload;
  } catch {
    return null;
  }
}

/**
 * Generate a receipt URL for a given receipt ID.
 */
export function getReceiptUrl(receiptId: string): string {
  return `/api/paylabs/receipts/${receiptId}`;
}
