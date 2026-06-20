/**
 * x402 Module — Barrel Export
 *
 * All x402 payment logic consolidated here:
 *
 *   types.ts         — PaymentExecutor interface, revenue split constants
 *   agent-context.ts — HMAC signing for paid agent capability calls
 *   buyer-transport.ts — x402 buyer-side flow (402 challenge → DCW sign → retry)
 *
 * Import from here instead of reaching into individual files:
 *   import { PaymentExecutor, computeSplit } from "@/lib/paylabs/x402";
 *   import { createAgentContext, verifyAgentContext } from "@/lib/paylabs/x402";
 *   import { callPaidSeller, X402BuyerError } from "@/lib/paylabs/x402";
 */

// ─── Types & Constants ─────────────────────────────────────────
export type {
  PaymentExecutor,
  PaymentQuoteInput,
  PaymentQuoteResult,
  PaymentPayInput,
  PaymentPayResult,
  PaymentReceiptResult,
} from "./types.js";

export {
  PAYLABS_CREATOR_BPS,
  PAYLABS_PLATFORM_BPS,
  PAYLABS_TREASURY_BPS,
  computeSplit,
} from "./types.js";

// ─── Agent Context (HMAC signing) ──────────────────────────────
export type {
  AgentContextPayload,
  CreateAgentContextInput,
  VerifyResult,
} from "./agent-context.js";

export {
  createAgentContext,
  verifyAgentContext,
  serializeAgentContext,
  parseAgentContext,
  getReceiptUrl,
} from "./agent-context.js";

// ─── Buyer Transport (x402 DCW buyer flow) ─────────────────────
export type {
  DcwSigner,
  X402BuyerCallInput,
  X402BuyerCallResult,
} from "./buyer-transport.js";

export {
  callPaidSeller,
  X402BuyerError,
} from "./buyer-transport.js";
