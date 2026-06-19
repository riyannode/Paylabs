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
  lesson_id: string;
  title?: string;
  source_id?: string;
  canonical_url?: string;
  publisher?: string;
  source_type?: string;
  normalized_sha256?: string;
  content_sha256?: string;
  is_published?: boolean;
  creator_wallet?: string;
  creator_verified?: boolean;
}

export interface VerifiedLesson {
  lesson_id: string;
  order_index: number;
  source_ok: boolean;
  creator_ok: boolean;
  verification_reason: string;
}

export interface RejectedLesson {
  lesson_id: string;
  reason: string;
}

export interface VerificationResult {
  verified: VerifiedLesson[];
  rejected: RejectedLesson[];
  allVerified: boolean;
  outputHash: string;
}

/**
 * Run deterministic source verification checks.
 * Same logic used in source-verifier-agent.ts and the paid specialist endpoint.
 */
export function runSourceVerification(
  lessons: VerificationInput[],
  config: RouteConfig
): VerificationResult {
  const verified: VerifiedLesson[] = [];
  const rejected: RejectedLesson[] = [];

  for (let i = 0; i < lessons.length; i++) {
    const lesson = lessons[i];
    const reasons: string[] = [];

    // Standard checks (all tiers)
    if (!lesson.source_id) reasons.push("source_id missing");
    if (!lesson.canonical_url) reasons.push("canonical_url missing");
    if (!lesson.normalized_sha256) reasons.push("normalized_sha256 missing");
    if (!lesson.content_sha256) reasons.push("content_sha256 missing");
    if (!lesson.is_published) reasons.push("not published");

    // High strictness (Advanced + Premium)
    if (config.sourceStrictness === "high" || config.sourceStrictness === "very_high") {
      if (!lesson.publisher) reasons.push("publisher missing (high strictness)");
    }

    // Very high strictness (Premium)
    if (config.sourceStrictness === "very_high") {
      if (!lesson.source_type) reasons.push("source_type missing (premium strictness)");
    }

    const sourceOk = reasons.length === 0;

    // Creator checks (all tiers)
    if (!lesson.creator_wallet) reasons.push("creator wallet missing");
    if (!lesson.creator_verified) reasons.push("creator not verified");

    const creatorOk = !!lesson.creator_wallet && !!lesson.creator_verified;

    if (sourceOk && creatorOk) {
      verified.push({
        lesson_id: lesson.lesson_id,
        order_index: i,
        source_ok: true,
        creator_ok: true,
        verification_reason: `Source verified [${config.sourceStrictness}]`,
      });
    } else {
      rejected.push({
        lesson_id: lesson.lesson_id,
        reason: reasons.join("; "),
      });
    }
  }

  // Compute output hash over verified lesson IDs
  const outputHash = createHash("sha256")
    .update(JSON.stringify({ verified: verified.map(v => v.lesson_id), rejected: rejected.map(r => r.lesson_id) }))
    .digest("hex");

  return { verified, rejected, allVerified: rejected.length === 0, outputHash };
}
