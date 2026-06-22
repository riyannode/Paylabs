/**
 * x402 Module — Barrel Export
 *
 * All x402 payment logic consolidated here:
 *
 *   types.ts            — PaymentExecutor interface, revenue split constants
 *   agent-context.ts    — HMAC signing for paid agent capability calls
 *   buyer-transport.ts  — x402 buyer-side flow (402 challenge → DCW sign → retry)
 *   gateway-balance.ts  — Circle Gateway balance verification for DCW wallets
 *   seller-challenge.ts — Seller-side x402 challenge + verify/settle
 *
 * Import from here instead of reaching into individual files:
 *   import { PaymentExecutor, computeSplit } from "@/lib/paylabs/x402";
 *   import { createAgentContext, verifyAgentContext } from "@/lib/paylabs/x402";
 *   import { callPaidSeller, X402BuyerError } from "@/lib/paylabs/x402";
 *   import { checkGatewayBalance, verifySufficientBalance } from "@/lib/paylabs/x402";
 *   import { buildX402Challenge, verifyAndSettlePayment } from "@/lib/paylabs/x402";
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

// ─── Gateway Balance Verification ───────────────────────────────
export type {
  GatewayBalanceResult,
  CheckGatewayBalanceInput,
} from "./gateway-balance.js";

export {
  checkGatewayBalance,
  verifySufficientBalance,
} from "./gateway-balance.js";

// ─── Seller Challenge (x402 402 response + verify/settle) ──────
export type {
  X402ChallengeRequirements,
  X402ChallengeResponse,
  VerifyAndSettleResult,
} from "./seller-challenge.js";

export {
  buildPaymentRequirements,
  buildX402Challenge,
  encodeChallengeHeader,
  verifyAndSettlePayment,
} from "./seller-challenge.js";

// ─── DCW Signer Adapter (lazy init, calls Circle API) ─────────
export { createDcwSigner } from "./dcw-signer-adapter.js";
