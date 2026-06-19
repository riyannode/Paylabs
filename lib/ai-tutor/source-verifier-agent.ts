/**
 * Agent 3: Source Verifier Agent (LLM reasoning + deterministic decision)
 * Verifies planned lessons are real source-backed content.
 *
 * Two paths:
 * - PAYLABS_AGENT_TO_AGENT_PAYMENTS=true: pay specialist via Runner, call endpoint with proof
 * - PAYLABS_AGENT_TO_AGENT_PAYMENTS=false: local verification (current path)
 *
 * If agent-to-agent payments are enabled and payment fails, BLOCK proposal.
 * Do NOT use unpaid specialist output.
 *
 * RFB 03: Agent-to-Agent Nanopayment Networks
 */

import type { PayLabsTutorStateType } from "./state";
import type { RouteTier } from "./route-config";
import { getRouteConfig } from "./route-config";
import { getPromptsForRoute } from "./route-prompts";
import { invokeJsonAgent } from "./llm-json";
import { getActiveAgentProvider, validateAgentServiceBudget, hashAgentServiceInput } from "./agent-providers";
import { executeAgentServicePurchase } from "@/lib/arclayer-runner/agent-services";
import { getSpecialistPaymentDecision, validateSpecialistDecision } from "./specialist-payment-decision";
import { runSourceVerification, type VerificationInput } from "./source-verifier-service";
import { supabaseAdmin } from "@/lib/supabase/server";
import { createHash } from "node:crypto";
import { z } from "zod";

// ─── Zod schema for LLM structured output ───────────────────────

const VerifierSchema = z.object({
  verification_notes: z.array(
    z.object({
      lesson_id: z.string().describe("The lesson being reviewed"),
      source_reasoning: z.string().describe("Reasoning about source integrity"),
      creator_reasoning: z.string().describe("Reasoning about creator trustworthiness"),
      risk_flags: z.array(z.string()).describe("Any risk flags found"),
    })
  ).describe("Per-lesson verification reasoning"),
});

type VerifierResult = z.infer<typeof VerifierSchema>;

// ─── Feature flag ────────────────────────────────────────────────

function isAgentToAgentPaymentsEnabled(): boolean {
  return process.env.PAYLABS_AGENT_TO_AGENT_PAYMENTS === "true";
}

// ─── Main agent ─────────────────────────────────────────────────

export async function sourceVerifierAgent(
  state: PayLabsTutorStateType
): Promise<Partial<PayLabsTutorStateType>> {
  const { selectedLessons, publishedLessons, routeTier, routePrompts, budgetUsdc, estimatedTotalUsdc, userWallet } = state;
  const tier: RouteTier = routeTier || "normal";
  const config = getRouteConfig(tier);
  const prompts = (routePrompts as unknown as ReturnType<typeof getPromptsForRoute>) || getPromptsForRoute(tier);

  if (!selectedLessons || selectedLessons.length === 0) {
    return {
      verifiedLessons: [],
      rejectedLessons: [],
      allVerified: false,
      error: "No lessons to verify",
    };
  }

  // Build lookup map
  const lessonMap = new Map<string, Record<string, unknown>>();
  for (const l of publishedLessons as Record<string, unknown>[]) {
    lessonMap.set(l.id as string, l);
  }

  // Prepare safe metadata for LLM
  const lessonMeta = (selectedLessons as Record<string, unknown>[]).map((s) => {
    const lesson = lessonMap.get(s.lesson_id as string);
    const source = lesson?.source as Record<string, unknown> | undefined;
    const creator = lesson?.creator as Record<string, unknown> | undefined;
    return {
      lesson_id: s.lesson_id,
      title: lesson?.title,
      source_id: source?.id,
      canonical_url: source?.canonical_url,
      publisher: source?.publisher,
      source_type: source?.source_type,
      normalized_sha256: source?.normalized_sha256,
      content_sha256: lesson?.content_sha256,
      is_published: lesson?.is_published,
      creator_wallet: creator?.wallet_address,
      creator_verified: creator?.is_verified,
    };
  });

  // ── Agent-to-Agent Payment Path ──
  if (isAgentToAgentPaymentsEnabled()) {
    return await paidSourceVerification({
      tier,
      config,
      prompts,
      lessonMeta,
      lessonMap,
      selectedLessons: selectedLessons as Record<string, unknown>[],
      budgetUsdc: budgetUsdc || 0,
      estimatedTotalUsdc: estimatedTotalUsdc || 0,
      userWallet: userWallet || "",
    });
  }

  // ── Local Verification Path (current behavior) ──
  return await localSourceVerification({
    tier,
    config,
    prompts,
    lessonMeta,
    lessonMap,
    selectedLessons: selectedLessons as Record<string, unknown>[],
  });
}

// ─── Local Verification Path ─────────────────────────────────────

async function localSourceVerification(input: {
  tier: RouteTier;
  config: ReturnType<typeof getRouteConfig>;
  prompts: ReturnType<typeof getPromptsForRoute>;
  lessonMeta: Record<string, unknown>[];
  lessonMap: Map<string, Record<string, unknown>>;
  selectedLessons: Record<string, unknown>[];
}): Promise<Partial<PayLabsTutorStateType>> {
  const { tier, config, prompts, lessonMeta, lessonMap, selectedLessons } = input;

  // Call LLM for reasoning
  const llmResult = await invokeJsonAgent<VerifierResult>({
    agentName: "source_verifier",
    routeTier: tier,
    prompt: prompts.sourceVerifier,
    userMessage: `Route tier: ${tier}\nSource strictness: ${config.sourceStrictness}\n\nLesson metadata to verify (JSON):\n${JSON.stringify(lessonMeta, null, 2)}\n\nReview each lesson's source integrity and creator trustworthiness. Flag any concerns.`,
    schema: VerifierSchema,
  });

  const llmNotes: Record<string, { source: string; creator: string; flags: string[] }> = {};
  let llmMeta: Record<string, unknown> = {};

  if (llmResult.ok) {
    const data = (llmResult as { ok: true; data: VerifierResult; meta: Record<string, unknown> }).data;
    llmMeta = (llmResult as { ok: true; data: VerifierResult; meta: Record<string, unknown> }).meta;
    for (const note of data.verification_notes) {
      llmNotes[note.lesson_id] = {
        source: note.source_reasoning,
        creator: note.creator_reasoning,
        flags: note.risk_flags,
      };
    }
  } else {
    const errResult = llmResult as { ok: false; error: string; meta: Record<string, unknown> };
    llmMeta = errResult.meta;
  }

  // Deterministic verification using shared service
  const verificationInputs: VerificationInput[] = selectedLessons.map((s) => {
    const lesson = lessonMap.get(s.lesson_id as string);
    const source = lesson?.source as Record<string, unknown> | undefined;
    const creator = lesson?.creator as Record<string, unknown> | undefined;
    return {
      lesson_id: s.lesson_id as string,
      title: lesson?.title as string,
      source_id: source?.id as string,
      canonical_url: source?.canonical_url as string,
      publisher: source?.publisher as string,
      source_type: source?.source_type as string,
      normalized_sha256: source?.normalized_sha256 as string,
      content_sha256: lesson?.content_sha256 as string,
      is_published: lesson?.is_published as boolean,
      creator_wallet: creator?.wallet_address as string,
      creator_verified: creator?.is_verified as boolean,
    };
  });

  const result = runSourceVerification(verificationInputs, config);

  const trace = {
    ...llmMeta,
    deterministic_verified: result.verified.length,
    deterministic_rejected: result.rejected.length,
    agent_to_agent: false,
  };

  return {
    verifiedLessons: result.verified,
    rejectedLessons: result.rejected,
    allVerified: result.allVerified,
    agentTrace: { source_verifier: trace },
    ...(llmResult.ok ? { llmOutputs: { source_verifier: (llmResult as { data: unknown }).data } } : { llmErrors: { source_verifier: llmResult } }),
  };
}

// ─── Paid Source Verification Path (RFB 03) ─────────────────────

async function paidSourceVerification(input: {
  tier: RouteTier;
  config: ReturnType<typeof getRouteConfig>;
  prompts: ReturnType<typeof getPromptsForRoute>;
  lessonMeta: Record<string, unknown>[];
  lessonMap: Map<string, Record<string, unknown>>;
  selectedLessons: Record<string, unknown>[];
  budgetUsdc: number;
  estimatedTotalUsdc: number;
  userWallet: string;
}): Promise<Partial<PayLabsTutorStateType>> {
  const { tier, config, lessonMeta, lessonMap, selectedLessons, budgetUsdc, estimatedTotalUsdc, userWallet } = input;

  // 1. Get provider (wallet resolved from env — zero address rejected)
  const provider = await getActiveAgentProvider("source_verification", tier);
  if (!provider) {
    return {
      error: "Agent-to-agent payments enabled but no active source_verification provider found (check PAYLABS_SOURCE_VERIFIER_WALLET env)",
      verifiedLessons: [],
      rejectedLessons: [],
      allVerified: false,
    };
  }

  // 2. Budget check
  const budgetError = validateAgentServiceBudget({
    budgetUsdc,
    alreadySpentUsdc: estimatedTotalUsdc,
    providerPrice: provider.price_usdc,
  });
  if (budgetError) {
    return {
      error: `Agent service budget check failed: ${budgetError}`,
      verifiedLessons: [],
      rejectedLessons: [],
      allVerified: false,
    };
  }

  // 3. LLM decision (advisory only — deterministic validation follows)
  const decisionResult = await getSpecialistPaymentDecision({
    routeTier: tier,
    budgetUsdc,
    estimatedLessonCostUsdc: estimatedTotalUsdc,
    lessonCount: selectedLessons.length,
    providerPriceUsdc: provider.price_usdc,
    providerAgentId: provider.agent_id,
  });

  // 4. Deterministic validation (final word)
  const validation = validateSpecialistDecision({
    decision: decisionResult.ok ? decisionResult.decision : {
      should_pay: tier === "premium", // premium always requires
      service_type: "source_verification",
      provider_agent_id: provider.agent_id,
      max_price_usdc: provider.price_usdc,
      reason: "LLM decision unavailable",
      expected_value: "source verification",
    },
    providerAgentId: provider.agent_id,
    providerPriceUsdc: provider.price_usdc,
    providerActive: provider.is_active,
    budgetUsdc,
    alreadySpentUsdc: estimatedTotalUsdc,
    agentToAgentEnabled: true,
    routeTier: tier,
  });

  if (!validation.valid) {
    return {
      error: `Agent-to-agent payment validation failed: ${validation.reason}`,
      verifiedLessons: [],
      rejectedLessons: [],
      allVerified: false,
    };
  }

  // 5. Execute payment via Runner
  const inputHash = hashAgentServiceInput(lessonMeta);
  const resourceUrl = provider.endpoint_url;

  const paymentResult = await executeAgentServicePurchase({
    buyerAgentId: "paylabs-langgraph-v1",
    providerAgentId: provider.agent_id,
    userWallet,
    resourceUrl,
    amountUsdc: String(provider.price_usdc),
    providerWallet: provider.wallet_address,
    inputHash,
  });

  if (!paymentResult.ok) {
    return {
      error: `Agent-to-agent payment failed: ${paymentResult.error}`,
      verifiedLessons: [],
      rejectedLessons: [],
      allVerified: false,
    };
  }

  // CRITICAL: Require complete proof
  if (!paymentResult.paymentId) {
    return {
      error: "Agent-to-agent payment returned no paymentId — cannot use service output",
      verifiedLessons: [],
      rejectedLessons: [],
      allVerified: false,
    };
  }

  if (!paymentResult.paymentRef && !paymentResult.settlementRef) {
    return {
      error: "Agent-to-agent payment returned no paymentRef or settlementRef — proof incomplete",
      verifiedLessons: [],
      rejectedLessons: [],
      allVerified: false,
    };
  }

  // 6. Call specialist endpoint with payment proof headers
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const endpointUrl = `${baseUrl}${resourceUrl}`;

  const serviceRes = await fetch(endpointUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-payment-id": paymentResult.paymentId,
      ...(paymentResult.paymentRef ? { "x-payment-ref": paymentResult.paymentRef } : {}),
      ...(paymentResult.settlementRef ? { "x-settlement-ref": paymentResult.settlementRef } : {}),
      "x-input-hash": inputHash,
      "x-provider-agent-id": provider.agent_id,
    },
    body: JSON.stringify({
      route_tier: tier,
      lessons: lessonMeta,
      input_hash: inputHash,
    }),
  });

  if (!serviceRes.ok) {
    const errBody = await serviceRes.text().catch(() => "unknown");
    return {
      error: `Specialist service returned ${serviceRes.status}: ${errBody}`,
      verifiedLessons: [],
      rejectedLessons: [],
      allVerified: false,
    };
  }

  const serviceData = await serviceRes.json() as {
    ok: boolean;
    verified_lessons: { lesson_id: string; order_index: number; source_ok: boolean; creator_ok: boolean; verification_reason: string }[];
    rejected_lessons: { lesson_id: string; reason: string }[];
    output_hash: string;
    error?: string;
  };

  if (!serviceData.ok) {
    return {
      error: `Specialist service failed: ${serviceData.error || "unknown"}`,
      verifiedLessons: [],
      rejectedLessons: [],
      allVerified: false,
    };
  }

  const outputHash = serviceData.output_hash;

  // 7. Record service call in DB — BLOCK proposal if insert fails
  const { data: serviceCall, error: serviceCallErr } = await supabaseAdmin()
    .from("paylabs_agent_service_calls")
    .insert({
      buyer_agent_id: "paylabs-langgraph-v1",
      provider_agent_id: provider.agent_id,
      user_wallet: userWallet.toLowerCase(),
      route_tier: tier,
      service_type: "source_verification",
      resource_url: resourceUrl,
      input_hash: inputHash,
      output_hash: outputHash,
      amount_usdc: provider.price_usdc,
      payment_id: paymentResult.paymentId,
      payment_ref: paymentResult.paymentRef || null,
      settlement_ref: paymentResult.settlementRef || null,
      status: "completed",
    })
    .select("id")
    .single();

  if (serviceCallErr || !serviceCall?.id) {
    return {
      error: `Failed to persist agent service call: ${serviceCallErr?.message || "no id returned"}. Audit trail required.`,
      verifiedLessons: [],
      rejectedLessons: [],
      allVerified: false,
    };
  }

  // 8. Build service call record for state — includes DB id
  const serviceCallRecord = {
    id: serviceCall.id,
    buyer_agent_id: "paylabs-langgraph-v1",
    provider_agent_id: provider.agent_id,
    service_type: "source_verification",
    amount_usdc: provider.price_usdc,
    payment_id: paymentResult.paymentId,
    payment_ref: paymentResult.paymentRef,
    settlement_ref: paymentResult.settlementRef,
    tx_hash: paymentResult.txHash,
    output_hash: outputHash,
    status: "completed",
  };

  const trace = {
    deterministic_verified: serviceData.verified_lessons.length,
    deterministic_rejected: serviceData.rejected_lessons.length,
    agent_to_agent: true,
    provider_agent_id: provider.agent_id,
    payment_id: paymentResult.paymentId,
    amount_usdc: provider.price_usdc,
    output_hash: outputHash,
  };

  return {
    verifiedLessons: serviceData.verified_lessons,
    rejectedLessons: serviceData.rejected_lessons,
    allVerified: serviceData.rejected_lessons.length === 0,
    agentTrace: { source_verifier: trace },
    agentServiceCalls: [serviceCallRecord],
  };
}
