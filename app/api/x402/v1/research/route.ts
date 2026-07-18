export const maxDuration = 300;

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { createDcwSigner } from "@/lib/paylabs/x402/dcw-signer-adapter";
import { buildCustomerEntryChallenge, verifyAndSettleCustomerEntry } from "@/lib/paylabs/x402/customer-entry-payment";
import { callPaidSeller } from "@/lib/paylabs/x402/buyer-transport";
import { runRouteOnlyBrainPreflight, buildRoutePreflightPaymentMeta } from "@/lib/paylabs/delegated-runtime/auto-tier-preflight";
import { isAutoTierPreflightEnabled } from "@/lib/paylabs/feature-flags";
import { resolvePublicAppUrl } from "@/lib/paylabs/runtime/resolve-app-url";
import { publicError } from "@/lib/paylabs/public-api/errors";
import { buildPublicRunResponse } from "@/lib/paylabs/public-api/response";
import { DEFAULT_BUDGET_USDC, PUBLIC_API_VERSION, PUBLIC_RESEARCH_PATH, SERVER_MAX_BUDGET_USDC, canonicalJson, createReadToken, normalizeAddress, parseUsdc, sha256Hex, usdcToAtomic } from "@/lib/paylabs/public-api/security";
import type { PublicResponseMode, PublicRouteTier } from "@/lib/paylabs/public-api/types";

const ALLOWED_TIERS = new Set<PublicRouteTier>(["auto", "easy", "normal", "advanced"]);
const ALLOWED_MODES = new Set<PublicResponseMode>(["compact", "full"]);
const MAX_BODY_BYTES = 32_768;
const CHALLENGE_TTL_MS = 15 * 60 * 1000;

function jsonSize(req: NextRequest): number {
  const raw = req.headers.get("content-length");
  return raw ? Number(raw) : 0;
}

function paymentHeader(req: NextRequest): string | null {
  return req.headers.get("payment-signature") || req.headers.get("x-payment");
}

function requestHash(input: { goal: string; route_tier: PublicRouteTier; max_budget_usdc: string; response_mode: PublicResponseMode; client_request_id: string | null }) {
  return sha256Hex(canonicalJson(input));
}

async function loadRun(runId: string) {
  const { data } = await supabaseAdmin().from("paylabs_discovery_runs").select("*").eq("id", runId).single();
  return data as Record<string, unknown> | null;
}

export async function POST(req: NextRequest) {
  if (!isAutoTierPreflightEnabled()) return publicError("PREFLIGHT_FAILED", "PayLabs locked preflight is not enabled.", { retryable: true });
  if (!/^application\/json/i.test(req.headers.get("content-type") || "")) return publicError("INVALID_REQUEST", "Content-Type must be application/json.");
  if (jsonSize(req) > MAX_BODY_BYTES) return publicError("INVALID_REQUEST", "Request payload is too large.");

  const rawBody = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!rawBody) return publicError("INVALID_REQUEST", "Request body must be valid JSON.");
  const goal = typeof rawBody.goal === "string" ? rawBody.goal.trim() : "";
  if (goal.length < 1 || goal.length > 2000) return publicError("INVALID_REQUEST", "goal is required and must be 1-2000 characters.");
  const tier = (rawBody.route_tier ?? "auto") as PublicRouteTier;
  if (!ALLOWED_TIERS.has(tier)) return publicError("INVALID_ROUTE_TIER", "Unsupported route_tier.");
  const mode = (rawBody.response_mode ?? "compact") as PublicResponseMode;
  if (!ALLOWED_MODES.has(mode)) return publicError("INVALID_REQUEST", "Unsupported response_mode.");
  const budget = parseUsdc(rawBody.max_budget_usdc, DEFAULT_BUDGET_USDC);
  if (!budget) return publicError("INVALID_REQUEST", "max_budget_usdc must be a positive USDC decimal with up to 6 decimals.");
  if (usdcToAtomic(budget) > usdcToAtomic(SERVER_MAX_BUDGET_USDC)) return publicError("BUDGET_EXCEEDED", `Budget exceeds server cap ${SERVER_MAX_BUDGET_USDC} USDC.`);
  const clientRequestId = typeof rawBody.client_request_id === "string" && rawBody.client_request_id.trim() ? rawBody.client_request_id.trim().slice(0, 128) : null;
  const hash = requestHash({ goal, route_tier: tier, max_budget_usdc: budget, response_mode: mode, client_request_id: clientRequestId });
  const signature = paymentHeader(req);

  const retryRunId = req.nextUrl.searchParams.get("runId") || (typeof rawBody.public_request_id === "string" ? rawBody.public_request_id : null);
  let run: Record<string, unknown> | null = null;

  if (retryRunId) {
    run = await loadRun(retryRunId);
    if (!run) return publicError("RUN_NOT_FOUND", "Run not found.");
    const publicCtx = ((run.agent_trace as Record<string, unknown> | null)?.public_x402 || {}) as Record<string, unknown>;
    if (publicCtx.request_hash !== hash) return publicError("INVALID_PAYMENT", "Request body does not match the locked x402 challenge.");
  } else if (clientRequestId && !signature) {
    const { data } = await supabaseAdmin().from("paylabs_discovery_runs").select("*").eq("client_request_id", clientRequestId).eq("request_hash", hash).order("created_at", { ascending: false }).limit(1).maybeSingle();
    run = data as Record<string, unknown> | null;
  }

  if (!run) {
    const now = new Date();
    const { token, hash: readTokenHash } = createReadToken();
    const { data: created, error } = await supabaseAdmin().from("paylabs_discovery_runs").insert({
      goal, user_wallet: "0x0000000000000000000000000000000000000000", route_tier: tier, status: "running", started_at: now.toISOString(), budget_usdc: Number(budget), runner_id: "public-x402", public_request_id: randomUUID(), client_request_id: clientRequestId, request_hash: hash, read_token_hash: readTokenHash, challenge_expires_at: new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString(), public_api_version: PUBLIC_API_VERSION, agent_trace: { public_x402: { request_hash: hash, response_mode: mode, read_token_preview: token.slice(0, 6), status: "preflight_pending" } },
    }).select("*").single();
    if (error || !created) return publicError("PREFLIGHT_FAILED", "Could not create public preflight context.", { retryable: true });
    run = created as Record<string, unknown>;
    try {
      const preflightResult = await runRouteOnlyBrainPreflight({ discoveryRunId: String(run.id), userGoal: goal, userBudgetUsdc: Number(budget), userWallet: "0x0000000000000000000000000000000000000000", requestedRouteTier: tier, dcwSigner: createDcwSigner() });
      const trace = run.agent_trace as Record<string, unknown>;
      await supabaseAdmin().from("paylabs_discovery_runs").update({ effective_route_tier: preflightResult.selectedTier, agent_trace: { ...trace, public_x402: { ...(trace.public_x402 as Record<string, unknown>), status: "awaiting_payment", read_token_hash: readTokenHash }, auto_tier_preflight: { status: "locked", requested_route_tier: tier, selected_tier: preflightResult.selectedTier, routing_fee_usdc: preflightResult.routingFeeUsdc, final_entry_payment_usdc: preflightResult.finalEntryPaymentUsdc, gross_user_charge_usdc: preflightResult.grossUserChargeUsdc, gross_run_charge_usdc: preflightResult.grossRunChargeUsdc, expected_internal_x402_routing_usdc: preflightResult.expectedInternalX402RoutingUsdc, locked_planned_cost_usdc: preflightResult.lockedQuote.plannedCostUsdc, locked_planned_cost_breakdown: preflightResult.lockedExecutionPlan.plannedCostBreakdown, locked_selected_macro_nodes: preflightResult.lockedExecutionPlan.selectedMacroNodes, locked_selected_services: preflightResult.lockedExecutionPlan.selectedServices, locked_expected_payment_edges: preflightResult.lockedQuote.expectedPaymentEdges, brain_fields: preflightResult.safeBrainFields, brain_llm_diag: preflightResult.brainLlmDiag ?? null, brain_payment: preflightResult.brainPaymentMeta ?? null, routing_payment: buildRoutePreflightPaymentMeta({ ok: true, settled: true, paymentMeta: { amountAtomic: "0", payTo: "internal", network: "arc-testnet", x402Version: 2, txHash: null, explorerUrl: null, settlementId: null, settlementUrl: null, batchTxHash: null, batchExplorerUrl: null, batchResolverUrl: null, gatewayAccepted: true, transferStatus: null } }) } } }).eq("id", run.id);
      run = await loadRun(String(run.id));
      (run as Record<string, unknown>).__readToken = token;
    } catch {
      await supabaseAdmin().from("paylabs_discovery_runs").update({ status: "failed", completed_at: new Date().toISOString(), error_summary: "public_x402_preflight_failed" }).eq("id", run.id);
      return publicError("PREFLIGHT_FAILED", "Route preflight failed.", { retryable: true, runId: String(run.id) });
    }
  }

  const trace = (run.agent_trace as Record<string, unknown>) || {};
  const pf = (trace.auto_tier_preflight as Record<string, unknown>) || {};
  const publicCtx = (trace.public_x402 as Record<string, unknown>) || {};
  const finalAmount = Number(pf.final_entry_payment_usdc);
  if (!Number.isFinite(finalAmount) || finalAmount <= 0) return publicError("LOCKED_QUOTE_EXPIRED", "Locked quote is unavailable or expired.", { runId: String(run.id) });
  if (new Date(String(run.challenge_expires_at)).getTime() < Date.now()) return publicError("LOCKED_QUOTE_EXPIRED", "Locked quote expired.", { runId: String(run.id) });

  if (!signature) {
    const { baseUrl } = resolvePublicAppUrl();
    const retryUrl = `${baseUrl}${PUBLIC_RESEARCH_PATH}?runId=${run.id}`;
    const { headerValue } = buildCustomerEntryChallenge(finalAmount, retryUrl);
    return publicError("PAYMENT_REQUIRED", "A valid x402 payment is required.", { state: "payment_required", runId: String(run.id), headers: { "PAYMENT-REQUIRED": headerValue, "x-payment-required": headerValue } });
  }

  const sigHash = sha256Hex(signature);
  if (publicCtx.payment_signature_hash === sigHash || run.payment_signature_hash === sigHash) return publicError("PAYMENT_REPLAYED", "Payment signature has already been used.", { runId: String(run.id) });
  const settled = await verifyAndSettleCustomerEntry(signature, finalAmount);
  if (!settled.ok || !settled.settled) return publicError("PAYMENT_SETTLEMENT_FAILED", "Payment settlement failed.", { runId: String(run.id), retryable: true });
  const payer = normalizeAddress(settled.payer);
  if (!payer) return publicError("INVALID_PAYMENT", "Verified payment did not include a valid payer wallet.", { runId: String(run.id) });

  if (clientRequestId) {
    const { data: duplicate } = await supabaseAdmin().from("paylabs_discovery_runs").select("*").eq("client_request_id", clientRequestId).eq("user_wallet", payer).in("status", ["paid_path_available", "discovery_only", "completed"]).neq("id", run.id).limit(1).maybeSingle();
    if (duplicate) return NextResponse.json(buildPublicRunResponse(duplicate as Record<string, unknown>, null, mode));
  }

  await supabaseAdmin().from("paylabs_discovery_runs").update({ user_wallet: payer, payment_signature_hash: sigHash, read_token_hash: sha256Hex(sigHash), entry_payment_status: "paid", entry_payment_amount_usdc: finalAmount, entry_payment_tx_hash: settled.paymentMeta?.txHash ?? null, entry_payment_explorer_url: settled.paymentMeta?.explorerUrl ?? null, entry_payment_settlement_id: settled.paymentMeta?.settlementId ?? null, entry_payment_batch_tx_hash: settled.paymentMeta?.batchTxHash ?? null, entry_payment_batch_explorer_url: settled.paymentMeta?.batchExplorerUrl ?? null, agent_trace: { ...trace, public_x402: { ...publicCtx, status: "entry_payment_settled", buyer_wallet: payer, payment_signature_hash: sigHash, read_token_hash: sha256Hex(sigHash) }, auto_tier_execution: { status: "final_payment_settled", final_entry_payment_usdc: finalAmount, final_payment: { status: "paid", amount_usdc: finalAmount, tx_hash: settled.paymentMeta?.txHash ?? null, explorer_url: settled.paymentMeta?.explorerUrl ?? null, settlement_id: settled.paymentMeta?.settlementId ?? null, settlement_url: settled.paymentMeta?.settlementUrl ?? null, batch_tx_hash: settled.paymentMeta?.batchTxHash ?? null, batch_explorer_url: settled.paymentMeta?.batchExplorerUrl ?? null, batch_resolver_url: settled.paymentMeta?.batchResolverUrl ?? null, gateway_accepted: settled.paymentMeta?.gatewayAccepted ?? true } } } }).eq("id", run.id);

  // Preserve existing route-preflight → execute-locked orchestration through the shared x402 buyer transport.
  // The external buyer is charged only by the public entry challenge; this internal edge records PayLabs runtime accounting.
  const { baseUrl } = resolvePublicAppUrl();
  const lockedResult = await callPaidSeller(createDcwSigner(), {
    sellerUrl: `${baseUrl}/api/paylabs/discovery-runs/execute-locked`,
    method: "POST",
    body: { discovery_run_id: run.id, user_wallet: payer, budget_usdc: budget },
    buyerWalletId: process.env.PAYLABS_BRAIN_BUYER_WALLET_ID || "",
    buyerAgentName: "paylabs-public-x402",
    sellerServiceName: "discovery",
    maxAmountUsdc: finalAmount.toFixed(6),
    requirePayment: true,
  });
  if (!lockedResult.ok) return publicError("RUN_FAILED", "Locked execution failed.", { runId: String(run.id), retryable: true });
  run = await loadRun(String(run.id));
  if (!run) return publicError("RUN_NOT_FOUND", "Run not found after execution.");
  return NextResponse.json(buildPublicRunResponse(run, sigHash, mode));
}
