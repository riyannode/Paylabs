/**
 * Agent 11: Creator Ownership Verifier
 * Verify monetization ownership from DB fields. Cannot create verification.
 */
import { z } from "zod";
import type { PayLabsTutorStateType } from "../state";
import { generateStructuredJson } from "../llm-structured";
import { getFeedItemById } from "../tools";

const Schema = z.object({
  ownership_results: z.array(z.object({
    feed_item_id: z.string(),
    ownership_ok: z.boolean(),
    monetization_ok: z.boolean(),
    reason: z.string(),
  })),
});

const SYSTEM_PROMPT = `You are PayLabs Creator Ownership Verifier Agent. Verify whether selected sources are discoverable. Ownership is not decided by the LLM. Use only DB fields from route/feed data: route verification_status, route is_monetized, route creator_wallet, feed item creator_wallet, feed item is_monetized. You cannot create verification. You cannot approve creator claims. You cannot set creator wallet. You cannot set price. You cannot execute payment.

IMPORTANT: Sources that are NOT monetized (is_monetized=false or creator_wallet=null) are still valid for discovery. Mark them as ownership_ok=true, monetization_ok=false. They will have creator_payout_usdc=0 and fee goes to treasury. Only reject sources that don't exist or have no content. Return structured JSON only.`;

export async function creatorOwnershipVerifierAgent(state: PayLabsTutorStateType) {
  const { selectedSources, routeTier } = state;
  const tier = routeTier || "normal";
  const selected = (selectedSources as Record<string, unknown>[]) || [];

  if (selected.length === 0) return { ownershipResults: [], verifiedSources: [], rejectedSources: [], allVerified: false };

  const verifiedSources: Record<string, unknown>[] = [];
  const rejectedSources: Record<string, unknown>[] = [];

  const sourceMeta: Record<string, unknown>[] = [];
  for (const s of selected) {
    try {
      const fi = await getFeedItemById(s.feed_item_id as string);
      const routeRaw = fi?.rsshub_route as unknown; const route = Array.isArray(routeRaw) ? routeRaw[0] as Record<string, unknown> : routeRaw as Record<string, unknown> | undefined;
      sourceMeta.push({
        feed_item_id: s.feed_item_id,
        feed_creator_wallet: fi?.creator_wallet,
        feed_is_monetized: fi?.is_monetized,
        route_verification_status: route?.verification_status,
        route_is_monetized: route?.is_monetized,
        route_creator_wallet: route?.creator_wallet,
      });
    } catch {
      sourceMeta.push({ feed_item_id: s.feed_item_id, error: "not found" });
    }
  }

  const result = await generateStructuredJson<z.infer<typeof Schema>>({
    agentName: "creator_ownership_verifier",
    routeTier: tier,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Route: ${tier}\n\nOwnership data from DB:\n${JSON.stringify(sourceMeta, null, 2)}\n\nVerify ownership and monetization. Return structured JSON only.`,
    schema: Schema,
  });

  if (!result.ok) return { error: `Creator ownership verifier failed: ${result.error}`, llmErrors: { creator_ownership_verifier: result }, ownershipResults: [], verifiedSources: [], rejectedSources: [], allVerified: false };

  // Split into verified/rejected based on ownership results
  // Unclaimed sources (ownership_ok=true, monetization_ok=false) are valid for discovery
  // with creator_payout_usdc=0. Only reject if ownership_ok=false (source doesn't exist).
  for (const r of result.data.ownership_results) {
    const original = selected.find(s => s.feed_item_id === r.feed_item_id);
    if (r.ownership_ok && original) {
      verifiedSources.push({
        ...original,
        claim_status: r.monetization_ok ? "verified" : "unclaimed",
        is_creator_payout_eligible: r.monetization_ok,
        creator_payout_usdc: r.monetization_ok ? undefined : 0,
      });
    } else {
      rejectedSources.push({ feed_item_id: r.feed_item_id, reason: r.reason });
    }
  }

  return {
    ownershipResults: result.data.ownership_results,
    verifiedSources,
    rejectedSources,
    allVerified: rejectedSources.length === 0 && verifiedSources.length > 0,
    agentTrace: { creator_ownership_verifier: result.meta },
    llmOutputs: { creator_ownership_verifier: result.data },
    agentCallCounts: { creator_ownership_verifier: 1 },
  };
}
