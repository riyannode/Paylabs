export const maxDuration = 300;

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { createDcwSigner } from "@/lib/paylabs/x402/dcw-signer-adapter";
import { buildCustomerEntryChallenge, verifyAndSettleCustomerEntry } from "@/lib/paylabs/x402/customer-entry-payment";
import { runRouteOnlyBrainPreflight } from "@/lib/paylabs/delegated-runtime/auto-tier-preflight";
import { isAutoTierPreflightEnabled } from "@/lib/paylabs/feature-flags";
import { resolvePaylabsAppUrl, resolvePublicAppUrl } from "@/lib/paylabs/runtime/resolve-app-url";
import { publicError } from "@/lib/paylabs/public-api/errors";
import { buildPublicRunResponse } from "@/lib/paylabs/public-api/response";
import { DEFAULT_BUDGET_USDC, PUBLIC_API_VERSION, PUBLIC_RESEARCH_PATH, SERVER_MAX_BUDGET_USDC, canonicalJson, constantTimeEqualHex, createReadToken, normalizeAddress, parseUsdc, sha256Hex, usdcToAtomic } from "@/lib/paylabs/public-api/security";
import type { PublicResponseMode, PublicRouteTier } from "@/lib/paylabs/public-api/types";
import { claimExecution, claimPaymentProcessing, claimRoutingPaymentProcessing, publicStatusFromRunStatus, updatePublicRunOrThrow } from "@/lib/paylabs/public-api/lifecycle";

const ALLOWED_TIERS = new Set<PublicRouteTier>(["auto", "easy", "normal", "advanced"]);
const ALLOWED_MODES = new Set<PublicResponseMode>(["compact", "full"]);
const MAX_BODY_BYTES = 32_768;
const ROUTING_FEE_USDC = "0.000001";
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
  const rawText = await req.text();
  if (Buffer.byteLength(rawText, "utf8") > MAX_BODY_BYTES) return publicError("INVALID_REQUEST", "Request payload is too large.");

  let rawBody: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return publicError("INVALID_REQUEST", "Request body must be a JSON object.");
    rawBody = parsed as Record<string, unknown>;
  } catch {
    return publicError("INVALID_REQUEST", "Request body must be valid JSON.");
  }
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
  if (clientRequestId) {
    const { data: conflicting } = await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .select("id, request_hash")
      .eq("client_request_id", clientRequestId)
      .not("public_api_version", "is", null)
      .neq("request_hash", hash)
      .limit(1)
      .maybeSingle();
    if (conflicting) {
      return publicError("IDEMPOTENCY_KEY_CONFLICT", "client_request_id was already used for a different request.", { status: 409 });
    }
  }
  const signature = paymentHeader(req);
  const suppliedReadToken = req.headers.get("x-paylabs-read-token") || (typeof rawBody.read_token === "string" ? rawBody.read_token : null);

  const retryRunId = req.nextUrl.searchParams.get("runId") || (typeof rawBody.public_request_id === "string" ? rawBody.public_request_id : null);
  let run: Record<string, unknown> | null = null;

  if (retryRunId) {
    run = await loadRun(retryRunId);
    if (!run) return publicError("RUN_NOT_FOUND", "Run not found.");
    const publicCtx = ((run.agent_trace as Record<string, unknown> | null)?.public_x402 || {}) as Record<string, unknown>;
    if (publicCtx.request_hash !== hash) return publicError("INVALID_PAYMENT", "Request body does not match the locked x402 challenge.");
  } else if (clientRequestId) {
    const { data } = await supabaseAdmin().from("paylabs_discovery_runs").select("*").eq("client_request_id", clientRequestId).eq("request_hash", hash).order("created_at", { ascending: false }).limit(1).maybeSingle();
    run = data as Record<string, unknown> | null;
  }

  if (!run || publicStatusFromRunStatus(run.status) === "created") {
    let token: string | null = null;
    let readTokenHash: string | null = null;
    if (!run) {
      const now = new Date();
      const createdToken = createReadToken();
      token = createdToken.token;
      readTokenHash = createdToken.hash;
      const { data: created, error } = await supabaseAdmin().from("paylabs_discovery_runs").insert({
      goal, user_wallet: "0x0000000000000000000000000000000000000000", route_tier: tier, status: "created", started_at: now.toISOString(), budget_usdc: Number(budget), runner_id: "public-x402", public_request_id: randomUUID(), client_request_id: clientRequestId, request_hash: hash, read_token_hash: readTokenHash, challenge_expires_at: new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString(), public_api_version: PUBLIC_API_VERSION, agent_trace: { public_x402: { request_hash: hash, response_mode: mode, read_token_preview: token?.slice(0, 6), status: "created" } },
      }).select("*").single();
      if (error || !created) {
      if (clientRequestId) {
        const { data: existing } = await supabaseAdmin()
          .from("paylabs_discovery_runs")
          .select("*")
          .eq("client_request_id", clientRequestId)
          .eq("request_hash", hash)
          .not("public_api_version", "is", null)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (existing) {
          run = existing as Record<string, unknown>;
        } else {
          return publicError("PREFLIGHT_FAILED", "Could not create public preflight context.", { retryable: true });
        }
      } else {
        return publicError("PREFLIGHT_FAILED", "Could not create public preflight context.", { retryable: true });
      }
      } else {
        run = created as Record<string, unknown>;
      }
    }
    if (!run) return publicError("PREFLIGHT_FAILED", "Could not create public preflight context.", { retryable: true });
    if (publicStatusFromRunStatus(run.status) !== "created") {
      // Existing idempotency owner already created or locked this challenge.
    } else try {
      if (!signature) {
        const { baseUrl } = resolvePublicAppUrl();
        const retryUrl = `${baseUrl}${PUBLIC_RESEARCH_PATH}?runId=${run.id}`;
        const { headerValue } = buildCustomerEntryChallenge(ROUTING_FEE_USDC, retryUrl);
        return NextResponse.json({
          ok: false,
          status: "payment_required",
          error: { code: "PAYMENT_REQUIRED", message: "A valid x402 routing payment is required.", retryable: false },
          run_id: run.id,
          retry_url: retryUrl,
          stage: "routing_preflight",
          ...(token ? { read_token: token, read_token_usage: "Send as Authorization: Bearer <token> when reading run status or receipts." } : {}),
        }, { status: 402, headers: { "PAYMENT-REQUIRED": headerValue, "x-payment-required": headerValue } });
      }

      const routingSigHash = sha256Hex(signature);
      const routingClaim = await claimRoutingPaymentProcessing(String(run.id), routingSigHash);
      if (!routingClaim) {
        const latest = await loadRun(String(run.id));
        return NextResponse.json({ ok: true, status: publicStatusFromRunStatus(latest?.status), run_id: run.id }, { status: 202 });
      }
      run = routingClaim;
      const routingPayment = await verifyAndSettleCustomerEntry(signature, ROUTING_FEE_USDC);
      if (!routingPayment.ok || !routingPayment.settled) {
        await updatePublicRunOrThrow(String(run.id), { status: "failed", completed_at: new Date().toISOString(), error_summary: "public_x402_routing_payment_failed" }, "public_routing_payment_failure_persist_failed").catch(() => null);
        return publicError("PAYMENT_SETTLEMENT_FAILED", "Routing payment settlement failed.", { runId: String(run.id), retryable: true });
      }

      const { data: preflightClaim, error: preflightClaimError } = await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .update({
          status: "running",
          routing_payment_settlement_id: routingPayment.paymentMeta?.settlementId ?? null,
          routing_payment_amount_usdc: ROUTING_FEE_USDC,
        })
        .eq("id", run.id)
        .eq("status", "payment_processing")
        .eq("routing_payment_signature_hash", routingSigHash)
        .select("*")
        .maybeSingle();
      if (preflightClaimError || !preflightClaim) {
        return publicError("GATEWAY_TEMPORARILY_UNAVAILABLE", "Routing payment was accepted but preflight persistence failed. Retry with the same request.", { runId: String(run.id), retryable: true });
      }
      run = preflightClaim as Record<string, unknown>;
      const preflightResult = await runRouteOnlyBrainPreflight({ discoveryRunId: String(run.id), userGoal: goal, userBudgetUsdc: Number(budget), userWallet: "0x0000000000000000000000000000000000000000", requestedRouteTier: tier, dcwSigner: createDcwSigner() });
      const trace = run.agent_trace as Record<string, unknown>;
      run = await updatePublicRunOrThrow(String(run.id), { status: "awaiting_payment", effective_route_tier: preflightResult.selectedTier, agent_trace: { ...trace, public_x402: { ...(trace.public_x402 as Record<string, unknown>), status: "awaiting_payment", ...(readTokenHash ? { read_token_hash: readTokenHash } : {}) }, auto_tier_preflight: { status: "locked", requested_route_tier: tier, selected_tier: preflightResult.selectedTier, routing_fee_usdc: preflightResult.routingFeeUsdc, final_entry_payment_usdc: preflightResult.finalEntryPaymentUsdc, gross_user_charge_usdc: preflightResult.grossUserChargeUsdc, gross_run_charge_usdc: preflightResult.grossRunChargeUsdc, expected_internal_x402_routing_usdc: preflightResult.expectedInternalX402RoutingUsdc, locked_planned_cost_usdc: preflightResult.lockedQuote.plannedCostUsdc, locked_planned_cost_breakdown: preflightResult.lockedExecutionPlan.plannedCostBreakdown, locked_selected_macro_nodes: preflightResult.lockedExecutionPlan.selectedMacroNodes, locked_selected_services: preflightResult.lockedExecutionPlan.selectedServices, locked_expected_payment_edges: preflightResult.lockedQuote.expectedPaymentEdges, brain_fields: preflightResult.safeBrainFields, brain_llm_diag: preflightResult.brainLlmDiag ?? null, brain_payment: preflightResult.brainPaymentMeta ?? null, routing_payment: { status: "paid", amount_usdc: ROUTING_FEE_USDC, settlement_id: routingPayment.paymentMeta?.settlementId ?? null, tx_hash: routingPayment.paymentMeta?.txHash ?? null, explorer_url: routingPayment.paymentMeta?.explorerUrl ?? null, gateway_accepted: routingPayment.paymentMeta?.gatewayAccepted ?? false } } } }, "public_preflight_persist_failed");
      (run as Record<string, unknown>).__readToken = token;
      const finalAmount = parseUsdc(preflightResult.finalEntryPaymentUsdc, "");
      if (!finalAmount) return publicError("PREFLIGHT_FAILED", "Preflight returned an invalid final payment amount.", { runId: String(run.id) });
      const { baseUrl } = resolvePublicAppUrl();
      const retryUrl = `${baseUrl}${PUBLIC_RESEARCH_PATH}?runId=${run.id}`;
      const { headerValue } = buildCustomerEntryChallenge(finalAmount, retryUrl);
      return NextResponse.json({
        ok: false,
        status: "payment_required",
        error: { code: "PAYMENT_REQUIRED", message: "A valid x402 final execution payment is required.", retryable: false },
        run_id: run.id,
        retry_url: retryUrl,
        stage: "final_execution",
        ...(token ? { read_token: token } : {}),
      }, { status: 402, headers: { "PAYMENT-REQUIRED": headerValue, "x-payment-required": headerValue } });
    } catch {
      await updatePublicRunOrThrow(String(run.id), { status: "failed", completed_at: new Date().toISOString(), error_summary: "public_x402_preflight_failed" }, "public_preflight_fail_persist_failed").catch(() => null);
      return publicError("PREFLIGHT_FAILED", "Route preflight failed.", { retryable: true, runId: String(run.id) });
    }
  }

  const trace = (run.agent_trace as Record<string, unknown>) || {};
  const pf = (trace.auto_tier_preflight as Record<string, unknown>) || {};
  const publicCtx = (trace.public_x402 as Record<string, unknown>) || {};
  const finalAmountUsdc = parseUsdc(pf.final_entry_payment_usdc, "");
  if (!finalAmountUsdc || usdcToAtomic(finalAmountUsdc) <= BigInt("0")) return publicError("LOCKED_QUOTE_EXPIRED", "Locked quote is unavailable or expired.", { runId: String(run.id) });
  if (new Date(String(run.challenge_expires_at)).getTime() < Date.now()) return publicError("LOCKED_QUOTE_EXPIRED", "Locked quote expired.", { runId: String(run.id) });

  if (!signature) {
    const { baseUrl } = resolvePublicAppUrl();
    const retryUrl = `${baseUrl}${PUBLIC_RESEARCH_PATH}?runId=${run.id}`;
    const { headerValue } = buildCustomerEntryChallenge(finalAmountUsdc, retryUrl);
    const readToken = typeof run.__readToken === "string" ? run.__readToken : null;
    return NextResponse.json({
      ok: false,
      status: "payment_required",
      error: { code: "PAYMENT_REQUIRED", message: "A valid x402 final execution payment is required.", retryable: false },
      run_id: run.id,
      retry_url: retryUrl,
      ...(readToken ? { read_token: readToken, read_token_usage: "Send as Authorization: Bearer <token> when reading run status or receipts." } : {}),
    }, { status: 402, headers: { "PAYMENT-REQUIRED": headerValue, "x-payment-required": headerValue } });
  }

  const sigHash = sha256Hex(signature);
  const currentStatus = publicStatusFromRunStatus(run.status);
  let claimed = null as Record<string, unknown> | null;
  if (currentStatus === "awaiting_payment") {
    claimed = await claimPaymentProcessing(String(run.id), sigHash).catch(() => null);
    if (!claimed) {
      const latest = await loadRun(String(run.id));
      if (latest?.payment_signature_hash === sigHash && publicStatusFromRunStatus(latest.status) !== "failed") {
        return NextResponse.json(buildPublicRunResponse(latest, null, mode), { status: 202 });
      }
      return publicError("PAYMENT_REPLAYED", "Another payment is already processing for this request.", { runId: String(run.id) });
    }
    run = claimed;
  } else if (run.payment_signature_hash === sigHash && ["payment_processing", "paid", "executing", "completed"].includes(currentStatus)) {
    if (currentStatus === "completed") return NextResponse.json(buildPublicRunResponse(run, null, mode));
  } else {
    return publicError("PAYMENT_REPLAYED", "Payment signature cannot be used for this run state.", { runId: String(run.id) });
  }

  const shouldSettle = claimed !== null;
  const settled = shouldSettle ? await verifyAndSettleCustomerEntry(signature, finalAmountUsdc) : null;
  if (shouldSettle && (!settled?.ok || !settled.settled)) {
    await updatePublicRunOrThrow(String(run.id), { status: "failed", completed_at: new Date().toISOString(), error_summary: "public_x402_payment_settlement_failed" }, "public_payment_failure_persist_failed").catch(() => null);
    return publicError("PAYMENT_SETTLEMENT_FAILED", "Payment settlement failed.", { runId: String(run.id), retryable: true });
  }
  const payer = normalizeAddress(settled?.payer) || normalizeAddress(run.user_wallet);
  if (!payer) return publicError("INVALID_PAYMENT", "Verified payment did not include a valid payer wallet.", { runId: String(run.id) });


  if (shouldSettle) {
    try {
      run = await updatePublicRunOrThrow(String(run.id), { user_wallet: payer, status: "paid", entry_payment_status: "paid", entry_payment_amount_usdc: finalAmountUsdc, entry_payment_tx_hash: settled?.paymentMeta?.txHash ?? null, entry_payment_explorer_url: settled?.paymentMeta?.explorerUrl ?? null, entry_payment_settlement_id: settled?.paymentMeta?.settlementId ?? null, entry_payment_batch_tx_hash: settled?.paymentMeta?.batchTxHash ?? null, entry_payment_batch_explorer_url: settled?.paymentMeta?.batchExplorerUrl ?? null, agent_trace: { ...trace, public_x402: { ...publicCtx, status: "paid", buyer_wallet: payer, payment_signature_hash: sigHash }, auto_tier_execution: { status: "final_payment_settled", final_entry_payment_usdc: finalAmountUsdc, final_payment: { status: "paid", amount_usdc: finalAmountUsdc, tx_hash: settled?.paymentMeta?.txHash ?? null, explorer_url: settled?.paymentMeta?.explorerUrl ?? null, settlement_id: settled?.paymentMeta?.settlementId ?? null, settlement_url: settled?.paymentMeta?.settlementUrl ?? null, batch_tx_hash: settled?.paymentMeta?.batchTxHash ?? null, batch_explorer_url: settled?.paymentMeta?.batchExplorerUrl ?? null, batch_resolver_url: settled?.paymentMeta?.batchResolverUrl ?? null, gateway_accepted: settled?.paymentMeta?.gatewayAccepted ?? false } } } }, "public_payment_persist_failed");
    } catch {
      return publicError("GATEWAY_TEMPORARILY_UNAVAILABLE", "Payment was accepted but persistence failed. Retry with the same request and signature for recovery.", { runId: String(run.id), retryable: true });
    }
  }

  // Execute locked orchestration through a trusted internal server-to-server mode.
  // This avoids a second x402 entry payment and prevents external-buyer/PayLabs-DCW payer mismatch.
  const internalExecuteToken = process.env.PAYLABS_INTERNAL_EXECUTE_TOKEN;
  if (!internalExecuteToken) return publicError("RUN_FAILED", "Internal execute authorization is not configured.", { runId: String(run.id), retryable: false });
  const executionClaim = await claimExecution(String(run.id)).catch(() => null);
  if (!executionClaim) {
    const latest = await loadRun(String(run.id));
    if (latest && publicStatusFromRunStatus(latest.status) === "completed") return NextResponse.json(buildPublicRunResponse(latest, null, mode));
    return NextResponse.json({ ok: true, status: "executing", run_id: run.id }, { status: 202 });
  }
  const { baseUrl } = resolvePaylabsAppUrl();
  const lockedResponse = await fetch(`${baseUrl}/api/paylabs/discovery-runs/execute-locked?runId=${run.id}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-paylabs-internal-execute-token": internalExecuteToken,
    },
    body: JSON.stringify({ discovery_run_id: run.id, user_wallet: payer, budget_usdc: budget }),
  }).catch(() => null);
  if (!lockedResponse?.ok) {
    const recovered = await loadRun(String(run.id));
    if (recovered && publicStatusFromRunStatus(recovered.status) === "completed") {
      run = recovered;
    } else {
      return publicError("RUN_FAILED", "Locked execution failed or timed out.", { runId: String(run.id), retryable: true });
    }
  } else {
    run = await loadRun(String(run.id));
  }
  if (!run) return publicError("RUN_NOT_FOUND", "Run not found after execution.");
  const responseReadToken = suppliedReadToken && constantTimeEqualHex(typeof run.read_token_hash === "string" ? run.read_token_hash : null, sha256Hex(suppliedReadToken)) ? suppliedReadToken : null;
  return NextResponse.json(buildPublicRunResponse(run, responseReadToken, mode));
}
