/**
 * Agent 3: Source Verifier Agent (LLM reasoning + deterministic decision)
 * Verifies planned sources are real RSSHub-backed content.
 *
 * Two paths:
 * - PAYLABS_AGENT_TO_AGENT_PAYMENTS=true: pay specialist via backend executor, call endpoint with proof
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
import { executeAgentServicePurchase } from "@/lib/paylabs/payment-executor/agent-services";
import { runSourceVerification, type VerificationInput } from "./source-verifier-service";
import { supabaseAdmin } from "@/lib/supabase/server";
import { z } from "zod";

// ─── Zod schema for LLM structured output ───────────────────────

const VerifierSchema = z.object({
  verification_notes: z.array(
    z.object({
      feed_item_id: z.string().describe("The feed item being reviewed"),
      source_reasoning: z.string().describe("Reasoning about source integrity"),
      route_reasoning: z.string().describe("Reasoning about RSSHub route trustworthiness"),
      risk_flags: z.array(z.string()).describe("Any risk flags found"),
    })
  ).describe("Per-source verification reasoning"),
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
  const { selectedSources, routeTier, routePrompts, budgetUsdc, estimatedTotalUsdc, userWallet } = state;
  const tier: RouteTier = routeTier || "normal";
  const config = getRouteConfig(tier);
  const prompts = (routePrompts as unknown as ReturnType<typeof getPromptsForRoute>) || getPromptsForRoute(tier);

  if (!selectedSources || selectedSources.length === 0) {
    return {
      verifiedSources: [],
      rejectedSources: [],
      allVerified: false,
      error: "No sources to verify",
    };
  }

  // Load feed items from DB — never trust state
  const { listFeedItems } = await import("./tools");
  const availableFeedItems = await listFeedItems() as Record<string, unknown>[];

  // Build lookup map
  const feedItemMap = new Map<string, Record<string, unknown>>();
  for (const item of availableFeedItems as Record<string, unknown>[]) {
    feedItemMap.set(item.id as string, item);
  }

  // Prepare safe metadata for LLM
  const sourceMeta = (selectedSources as Record<string, unknown>[]).map((s) => {
    const feedItem = feedItemMap.get(s.feed_item_id as string);
    const route = feedItem?.rsshub_route as Record<string, unknown> | undefined;
    return {
      feed_item_id: s.feed_item_id,
      title: feedItem?.title,
      route_id: route?.id,
      route_path: route?.route_path,
      route_title: route?.title,
      content_sha256: feedItem?.content_sha256,
      published_at: feedItem?.published_at,
      is_active: route?.is_active,
    };
  });

  // ── Agent-to-Agent Payment Path ──
  if (isAgentToAgentPaymentsEnabled()) {
    return await paidSourceVerification({
      tier,
      config,
      prompts,
      sourceMeta,
      feedItemMap,
      selectedSources: selectedSources as Record<string, unknown>[],
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
    sourceMeta,
    feedItemMap,
    selectedSources: selectedSources as Record<string, unknown>[],
  });
}

// ─── Local Verification Path ─────────────────────────────────────

async function localSourceVerification(input: {
  tier: RouteTier;
  config: ReturnType<typeof getRouteConfig>;
  prompts: ReturnType<typeof getPromptsForRoute>;
  sourceMeta: Record<string, unknown>[];
  feedItemMap: Map<string, Record<string, unknown>>;
  selectedSources: Record<string, unknown>[];
}): Promise<Partial<PayLabsTutorStateType>> {
  const { tier, config, prompts, sourceMeta, feedItemMap, selectedSources } = input;

  // Call LLM for reasoning
  const llmResult = await invokeJsonAgent<VerifierResult>({
    agentName: "source_verifier",
    routeTier: tier,
    prompt: prompts.sourceVerifier,
    userMessage: `Route tier: ${tier}\nSource strictness: ${config.sourceStrictness}\n\nSource metadata to verify (JSON):\n${JSON.stringify(sourceMeta, null, 2)}\n\nReview each source's integrity and RSSHub route trustworthiness. Flag any concerns.`,
    schema: VerifierSchema,
  });

  const llmNotes: Record<string, { source: string; route: string; flags: string[] }> = {};
  let llmMeta: Record<string, unknown> = {};

  if (llmResult.ok) {
    const data = (llmResult as { ok: true; data: VerifierResult; meta: Record<string, unknown> }).data;
    llmMeta = (llmResult as { ok: true; data: VerifierResult; meta: Record<string, unknown> }).meta;
    for (const note of data.verification_notes) {
      llmNotes[note.feed_item_id] = {
        source: note.source_reasoning,
        route: note.route_reasoning,
        flags: note.risk_flags,
      };
    }
  } else {
    const errResult = llmResult as { ok: false; error: string; meta: Record<string, unknown> };
    llmMeta = errResult.meta;
  }

  // Deterministic verification using shared service
  const verificationInputs: VerificationInput[] = selectedSources.map((s) => {
    const feedItem = feedItemMap.get(s.feed_item_id as string);
    const route = feedItem?.rsshub_route as Record<string, unknown> | undefined;
    return {
      feed_item_id: s.feed_item_id as string,
      title: feedItem?.title as string,
      route_id: route?.id as string,
      route_path: route?.route_path as string,
      route_title: route?.title as string,
      content_sha256: feedItem?.content_sha256 as string,
      published_at: feedItem?.published_at as string,
      route_is_active: route?.is_active as boolean,
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
    verifiedSources: result.verified,
    rejectedSources: result.rejected,
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
  sourceMeta: Record<string, unknown>[];
  feedItemMap: Map<string, Record<string, unknown>>;
  selectedSources: Record<string, unknown>[];
  budgetUsdc: number;
  estimatedTotalUsdc: number;
  userWallet: string;
}): Promise<Partial<PayLabsTutorStateType>> {
  const { tier, config, sourceMeta, feedItemMap, selectedSources, budgetUsdc, estimatedTotalUsdc, userWallet } = input;

  // 1. Get provider (wallet resolved from env — zero address rejected)
  const provider = await getActiveAgentProvider("source_verification", tier);
  if (!provider) {
    return {
      error: "Agent-to-agent payments enabled but no active source_verification provider found (check PAYLABS_SOURCE_VERIFIER_WALLET env)",
      verifiedSources: [],
      rejectedSources: [],
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
      verifiedSources: [],
      rejectedSources: [],
      allVerified: false,
    };
  }

  // 3. Determine if payment is required (premium always requires)
  const shouldPay = tier === "premium";

  // 4. Execute payment via backend executor
  const inputHash = hashAgentServiceInput(sourceMeta);
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
      verifiedSources: [],
      rejectedSources: [],
      allVerified: false,
    };
  }

  // CRITICAL: Require complete proof
  if (!paymentResult.paymentId) {
    return {
      error: "Agent-to-agent payment returned no paymentId — cannot use service output",
      verifiedSources: [],
      rejectedSources: [],
      allVerified: false,
    };
  }

  if (!paymentResult.paymentRef && !paymentResult.settlementRef) {
    return {
      error: "Agent-to-agent payment returned no paymentRef or settlementRef — proof incomplete",
      verifiedSources: [],
      rejectedSources: [],
      allVerified: false,
    };
  }

  // 5. Call specialist endpoint with payment proof headers
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
      sources: sourceMeta,
      input_hash: inputHash,
    }),
  });

  if (!serviceRes.ok) {
    const errBody = await serviceRes.text().catch(() => "unknown");
    return {
      error: `Specialist service returned ${serviceRes.status}: ${errBody}`,
      verifiedSources: [],
      rejectedSources: [],
      allVerified: false,
    };
  }

  const serviceData = await serviceRes.json() as {
    ok: boolean;
    verified_sources: { feed_item_id: string; order_index: number; source_ok: boolean; route_ok: boolean; verification_reason: string }[];
    rejected_sources: { feed_item_id: string; reason: string }[];
    output_hash: string;
    error?: string;
  };

  if (!serviceData.ok) {
    return {
      error: `Specialist service failed: ${serviceData.error || "unknown"}`,
      verifiedSources: [],
      rejectedSources: [],
      allVerified: false,
    };
  }

  const outputHash = serviceData.output_hash;

  // 6. Record service call in DB — BLOCK proposal if insert fails
  const { data: serviceCall, error: serviceCallErr } = await supabaseAdmin()
    .from("paylabs_agent_payments")
    .insert({
      buyer_agent_id: "paylabs-langgraph-v1",
      provider_agent_id: provider.agent_id,
      user_wallet: userWallet.toLowerCase(),
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
      error: `Failed to persist agent payment: ${serviceCallErr?.message || "no id returned"}. Audit trail required.`,
      verifiedSources: [],
      rejectedSources: [],
      allVerified: false,
    };
  }

  // 7. Build service call record for state — includes DB id
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
    deterministic_verified: serviceData.verified_sources.length,
    deterministic_rejected: serviceData.rejected_sources.length,
    agent_to_agent: true,
    provider_agent_id: provider.agent_id,
    payment_id: paymentResult.paymentId,
    amount_usdc: provider.price_usdc,
    output_hash: outputHash,
  };

  return {
    verifiedSources: serviceData.verified_sources,
    rejectedSources: serviceData.rejected_sources,
    allVerified: serviceData.rejected_sources.length === 0,
    agentTrace: { source_verifier: trace },
    agentServiceCalls: [serviceCallRecord],
  };
}
