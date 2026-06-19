/**
 * Source Verifier Service
 * Shared verification logic extracted from source-verifier-agent.ts.
 * Used by both local verification and the paid specialist endpoint.
 *
 * Deterministic checks only — no LLM, no payment.
 */

import { createHash } from "node:crypto";
import type { RouteConfig } from "./route-config";

export interface VerificationInput {
  feed_item_id: string;
  title?: string;
  route_id?: string;
  route_path?: string;
  route_title?: string;
  content_sha256?: string;
  published_at?: string;
  route_is_active?: boolean;
}

export interface VerifiedSource {
  feed_item_id: string;
  order_index: number;
  source_ok: boolean;
  route_ok: boolean;
  verification_reason: string;
}

export interface RejectedSource {
  feed_item_id: string;
  reason: string;
}

export interface VerificationResult {
  verified: VerifiedSource[];
  rejected: RejectedSource[];
  allVerified: boolean;
  outputHash: string;
}

/**
 * Run deterministic source verification checks.
 * Same logic used in source-verifier-agent.ts and the paid specialist endpoint.
 */
export function runSourceVerification(
  sources: VerificationInput[],
  config: RouteConfig
): VerificationResult {
  const verified: VerifiedSource[] = [];
  const rejected: RejectedSource[] = [];

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const reasons: string[] = [];

    // Standard checks (all tiers)
    if (!source.route_id) reasons.push("route_id missing");
    if (!source.route_path) reasons.push("route_path missing");
    if (!source.content_sha256) reasons.push("content_sha256 missing");
    if (!source.published_at) reasons.push("published_at missing");

    // High strictness (Advanced + Premium)
    if (config.sourceStrictness === "high" || config.sourceStrictness === "very_high") {
      if (!source.route_title) reasons.push("route_title missing (high strictness)");
    }

    // Very high strictness (Premium)
    if (config.sourceStrictness === "very_high") {
      if (!source.route_is_active) reasons.push("route not active (premium strictness)");
    }

    const sourceOk = reasons.length === 0;

    // Route checks (all tiers)
    const routeOk = !!source.route_id && !!source.route_is_active;
    if (!routeOk && sourceOk) reasons.push("RSSHub route inactive");

    if (sourceOk && routeOk) {
      verified.push({
        feed_item_id: source.feed_item_id,
        order_index: i,
        source_ok: true,
        route_ok: true,
        verification_reason: `Source verified [${config.sourceStrictness}]`,
      });
    } else {
      rejected.push({
        feed_item_id: source.feed_item_id,
        reason: reasons.join("; "),
      });
    }
  }

  // Compute output hash over verified feed item IDs
  const outputHash = createHash("sha256")
    .update(JSON.stringify({ verified: verified.map(v => v.feed_item_id), rejected: rejected.map(r => r.feed_item_id) }))
    .digest("hex");

  return { verified, rejected, allVerified: rejected.length === 0, outputHash };
}
