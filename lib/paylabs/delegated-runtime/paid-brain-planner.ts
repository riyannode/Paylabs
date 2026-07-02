/**
 * Paid Brain Planner — Call Brain LLM through Circle x402 seller.
 *
 * Extracts the callBrainX402 pattern from old inline/route.ts into
 * a shared helper used by route-preflight (auto-tier-preflight).
 *
 * Calls /api/paylabs/brain/run via callPaidSeller with:
 * - buyerAgentName: "run_budget_controller"
 * - sellerServiceName: "brain"
 * - requirePayment: true
 *
 * Returns safe Brain planning, diagnostics, and payment metadata.
 * Never exposes raw x-payment headers, signatures, or Gateway response.
 */

import type { DcwSigner } from "@/lib/paylabs/x402/buyer-transport";
import { resolvePaylabsAppUrl } from "@/lib/paylabs/runtime/resolve-app-url";
import { FIXED_FEES_USDC } from "./quote-engine";

// ─── Types ──────────────────────────────────────────────────

/** Safe Brain LLM diagnostics (no raw content) */
export interface SafeBrainLlmDiag {
  provider: string;
  model: string;
  agent_name: string;
  mode: string;
  max_tokens: number | null;
  timeout_ms: number | null;
  streaming: boolean | null;
  force_non_streaming_body: boolean | null;
  json_found: boolean | null;
  parse_ok: boolean | null;
  validation_ok: boolean | null;
  received_keys: string[] | null;
  expected_keys: string[] | null;
  validation_issue_paths: string[] | null;
  content_type: string | null;
  content_length: number | null;
  error_code: string | null;
  error_safe: string | null;
  safe_error: string | null;
}

/** Safe Brain payment metadata from Circle x402 settle */
export interface SafeBrainPaymentMeta {
  status: string;
  amount_usdc: number;
  tx_hash: string | null;
  explorer_url: string | null;
  settlement_id: string | null;
  settlement_url: string | null;
  batch_tx_hash: string | null;
  batch_explorer_url: string | null;
  batch_resolver_url: string | null;
  gateway_accepted: boolean;
  transfer_status: string | null;
  mode: string | null;
}

/** Result from paid Brain planner call */
export interface PaidBrainPlannerResult {
  ok: boolean;
  brainPlanning: Record<string, unknown> | null;
  brainLlmDiag: SafeBrainLlmDiag | null;
  brainPaymentMeta: SafeBrainPaymentMeta | null;
  error: string | null;
}

// ─── Main Function ──────────────────────────────────────────

/**
 * Call Brain LLM through Circle x402 seller endpoint.
 *
 * Same behavior as old inline callBrainX402:
 * - Uses callPaidSeller to /api/paylabs/brain/run
 * - Buyer: run_budget_controller
 * - Seller: brain
 * - Amount: FIXED_FEES_USDC.brainTreasury (0.000003 USDC)
 *
 * @returns Safe Brain planning, diagnostics, and payment metadata
 */
export async function callPaidBrainPlanner(params: {
  dcwSigner: DcwSigner;
  discoveryRunId: string;
  userGoal: string;
  routeTier: string;
  userBudgetUsdc: number;
  userWallet: string;
}): Promise<PaidBrainPlannerResult> {
  const { dcwSigner, discoveryRunId, userGoal, routeTier, userBudgetUsdc, userWallet } = params;

  const { callPaidSeller } = await import("@/lib/paylabs/x402/buyer-transport");
  const { baseUrl } = resolvePaylabsAppUrl();

  const result = await callPaidSeller(dcwSigner, {
    sellerUrl: `${baseUrl}/api/paylabs/brain/run`,
    method: "POST",
    body: {
      userGoal,
      routeTier,
      userBudgetUsdc,
      discoveryRunId,
      userWallet,
    },
    buyerWalletId:
      process.env.PAYLABS_CONTROLLER_BUYER_WALLET_ID ||
      process.env.PAYLABS_RUN_BUDGET_CONTROLLER_BUYER_WALLET_ID ||
      "",
    buyerAgentName: "run_budget_controller",
    sellerServiceName: "brain" as import("@/lib/paylabs/agent-services/types").ServiceName,
    discoveryRunId,
    maxAmountUsdc: "0.001",
    requirePayment: true,
  });

  if (!result.ok || !result.data) {
    return {
      ok: false,
      brainPlanning: null,
      brainLlmDiag: null,
      brainPaymentMeta: null,
      error: result.error || "Brain x402 call failed",
    };
  }

  const paidData = result.data as Record<string, unknown>;

  // ── Extract brainPlanning (flat or nested) ──
  // brain/run returns brainPlanning at top level
  // callPaidSeller may wrap in .data
  let brainPlanning: Record<string, unknown> | null = null;
  let rawDiag: Record<string, unknown> | undefined;

  if (paidData.brainPlanning) {
    brainPlanning = paidData.brainPlanning as Record<string, unknown>;
    rawDiag = paidData.brainLlmDiag as Record<string, unknown> | undefined;
  } else if (
    (paidData as Record<string, unknown>).data &&
    ((paidData as Record<string, unknown>).data as Record<string, unknown>).brainPlanning
  ) {
    const nested = (paidData as Record<string, unknown>).data as Record<string, unknown>;
    brainPlanning = nested.brainPlanning as Record<string, unknown>;
    rawDiag = nested.brainLlmDiag as Record<string, unknown> | undefined;
  }

  if (!brainPlanning) {
    return {
      ok: false,
      brainPlanning: null,
      brainLlmDiag: null,
      brainPaymentMeta: buildSafeBrainPaymentMeta(result.paymentMetadata),
      error: "Brain planning not found in x402 response",
    };
  }

  // ── Build safe diagnostics ──
  const brainLlmDiag: SafeBrainLlmDiag | null = rawDiag
    ? {
        provider: (rawDiag.provider as string) ?? "unknown",
        model: (rawDiag.model as string) ?? "unknown",
        agent_name: (rawDiag.agent_name as string) ?? "unknown",
        mode: (rawDiag.mode as string) ?? "unknown",
        max_tokens: (rawDiag.max_tokens as number) ?? null,
        timeout_ms: (rawDiag.timeout_ms as number) ?? null,
        streaming: (rawDiag.streaming as boolean) ?? null,
        force_non_streaming_body: (rawDiag.force_non_streaming_body as boolean) ?? null,
        json_found: (rawDiag.json_found as boolean) ?? null,
        parse_ok: (rawDiag.parse_ok as boolean) ?? null,
        validation_ok: (rawDiag.validation_ok as boolean) ?? null,
        received_keys: (rawDiag.received_keys as string[]) ?? null,
        expected_keys: (rawDiag.expected_keys as string[]) ?? null,
        validation_issue_paths: (rawDiag.validation_issue_paths as string[]) ?? null,
        content_type: (rawDiag.content_type as string) ?? null,
        content_length: (rawDiag.content_length as number) ?? null,
        error_code: (rawDiag.error_code as string) ?? null,
        error_safe: (rawDiag.error_safe as string) ?? null,
        safe_error: ((rawDiag.error_safe as string) ?? null)?.slice(0, 220) ?? null,
      }
    : null;

  return {
    ok: true,
    brainPlanning,
    brainLlmDiag,
    brainPaymentMeta: buildSafeBrainPaymentMeta(result.paymentMetadata),
    error: null,
  };
}

// ─── Helpers ─────────────────────────────────────────────────

function buildSafeBrainPaymentMeta(
  paymentMetadata:
    | {
        txHash?: string | null;
        explorerUrl?: string | null;
        settlementId?: string | null;
        settlementUrl?: string | null;
        batchTxHash?: string | null;
        batchExplorerUrl?: string | null;
        batchResolverUrl?: string | null;
        gatewayAccepted?: boolean;
        transferStatus?: string | null;
      }
    | null
    | undefined,
): SafeBrainPaymentMeta {
  return {
    status: "paid",
    amount_usdc: FIXED_FEES_USDC.brainTreasury,
    tx_hash: paymentMetadata?.txHash ?? null,
    explorer_url: paymentMetadata?.explorerUrl ?? null,
    settlement_id: paymentMetadata?.settlementId ?? null,
    settlement_url: paymentMetadata?.settlementUrl ?? null,
    batch_tx_hash: paymentMetadata?.batchTxHash ?? null,
    batch_explorer_url: paymentMetadata?.batchExplorerUrl ?? null,
    batch_resolver_url: paymentMetadata?.batchResolverUrl ?? null,
    gateway_accepted: paymentMetadata?.gatewayAccepted ?? true,
    transfer_status: paymentMetadata?.transferStatus ?? null,
    mode: "x402",
  };
}
