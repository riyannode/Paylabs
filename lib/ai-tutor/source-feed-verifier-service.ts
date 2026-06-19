/**
 * Source Feed Verifier Service
 * Deterministic verification for RSSHub feed items.
 * Separate from source-verifier-service.ts (which is lesson-only).
 *
 * No LLM, no payment — pure deterministic checks.
 */

import { createHash } from "node:crypto";
import type { RouteConfig } from "./route-config";

export interface VerificationFeedItemInput {
  feed_item_id: string;
  title?: string;
  canonical_url?: string;
  publisher?: string;
  author_name?: string;
  normalized_sha256?: string;
  content_sha256?: string;
  is_active?: boolean;
  creator_wallet?: string;
}

export interface VerifiedFeedItem {
  feed_item_id: string;
  order_index: number;
  source_ok: boolean;
  creator_ok: boolean;
  verification_reason: string;
  hash_status: "verified" | "missing";
}

export interface RejectedFeedItem {
  feed_item_id: string;
  reason: string;
}

export interface SourceFeedVerificationResult {
  verified: VerifiedFeedItem[];
  rejected: RejectedFeedItem[];
  allVerified: boolean;
  outputHash: string;
}

/**
 * Run deterministic source verification checks on feed items.
 * Same pattern as runSourceVerification() but for RSSHub feed items.
 */
export function runSourceFeedVerification(
  items: VerificationFeedItemInput[],
  config: RouteConfig
): SourceFeedVerificationResult {
  const verified: VerifiedFeedItem[] = [];
  const rejected: RejectedFeedItem[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const reasons: string[] = [];

    // Standard checks (all tiers)
    if (!item.canonical_url) reasons.push("canonical_url missing");
    if (!item.normalized_sha256 && !item.content_sha256) {
      reasons.push("no content hash (normalized_sha256 or content_sha256 required)");
    }
    if (!item.is_active) reasons.push("feed item not active");

    // Creator checks (all tiers)
    if (!item.creator_wallet) reasons.push("creator wallet missing");
    const creatorOk = !!item.creator_wallet && isEvmAddress(item.creator_wallet || "");
    if (item.creator_wallet && !creatorOk) reasons.push("creator wallet not valid EVM address");

    // High strictness (Advanced = high)
    if (config.sourceStrictness === "high" || config.sourceStrictness === "very_high") {
      if (!item.publisher && !item.author_name) {
        reasons.push("publisher or author_name required (high strictness)");
      }
    }

    // Very high strictness (Advanced = very_high)
    if (config.sourceStrictness === "very_high") {
      if (!item.canonical_url || (!item.normalized_sha256 && !item.content_sha256)) {
        reasons.push("both URL and hash required (very_high strictness)");
      }
    }

    const sourceOk = reasons.length === 0;

    const hashStatus: "verified" | "missing" =
      item.normalized_sha256 || item.content_sha256 ? "verified" : "missing";

    if (sourceOk && creatorOk) {
      verified.push({
        feed_item_id: item.feed_item_id,
        order_index: i,
        source_ok: true,
        creator_ok: true,
        verification_reason: `Feed item verified [${config.sourceStrictness}]`,
        hash_status: hashStatus,
      });
    } else {
      rejected.push({
        feed_item_id: item.feed_item_id,
        reason: reasons.join("; "),
      });
    }
  }

  // Compute output hash over verified feed item IDs
  const outputHash = createHash("sha256")
    .update(
      JSON.stringify({
        verified: verified.map((v) => v.feed_item_id),
        rejected: rejected.map((r) => r.feed_item_id),
      })
    )
    .digest("hex");

  return { verified, rejected, allVerified: rejected.length === 0, outputHash };
}

/**
 * Validate EVM address format.
 */
function isEvmAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}
