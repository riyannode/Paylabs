/**
 * Agent 3: Source Verifier Agent
 * Verifies planned lessons are real source-backed content.
 * No payment, no Runner — read-only.
 * Route tier controls source strictness level.
 */

import type { PayLabsTutorStateType } from "./state";
import type { RouteTier } from "./route-config";
import { getRouteConfig } from "./route-config";

interface VerifiedLesson {
  lesson_id: string;
  order_index: number;
  source_ok: boolean;
  creator_ok: boolean;
  verification_reason: string;
}

interface RejectedLesson {
  lesson_id: string;
  reason: string;
}

export async function sourceVerifierAgent(
  state: PayLabsTutorStateType
): Promise<Partial<PayLabsTutorStateType>> {
  const { selectedLessons, publishedLessons, routeTier } = state;
  const tier: RouteTier = routeTier || "normal";
  const config = getRouteConfig(tier);

  if (!selectedLessons || selectedLessons.length === 0) {
    return {
      verifiedLessons: [],
      rejectedLessons: [],
      allVerified: false,
      error: "No lessons to verify",
    };
  }

  // Build a lookup map from published lessons
  const lessonMap = new Map<string, Record<string, unknown>>();
  for (const l of publishedLessons as Record<string, unknown>[]) {
    lessonMap.set(l.id as string, l);
  }

  const verified: VerifiedLesson[] = [];
  const rejected: RejectedLesson[] = [];

  for (const selected of selectedLessons as Record<string, unknown>[]) {
    const lessonId = selected.lesson_id as string;
    const lesson = lessonMap.get(lessonId);

    if (!lesson) {
      rejected.push({ lesson_id: lessonId, reason: "Lesson not found in published lessons" });
      continue;
    }

    const reasons: string[] = [];

    // ── Standard checks (all tiers) ──
    const source = lesson.source as Record<string, unknown> | undefined;
    if (!source?.id) reasons.push("source_id missing");
    if (!source?.canonical_url) reasons.push("canonical_url missing");
    if (!source?.normalized_sha256) reasons.push("normalized_sha256 missing");
    if (!lesson.content_sha256) reasons.push("content_sha256 missing");
    if (!lesson.is_published) reasons.push("not published");

    // ── High strictness checks (Advanced + Premium) ──
    if (config.sourceStrictness === "high" || config.sourceStrictness === "very_high") {
      if (!source?.publisher) reasons.push("publisher missing (high strictness)");
    }

    // ── Very high strictness checks (Premium only) ──
    if (config.sourceStrictness === "very_high") {
      if (!source?.source_type) reasons.push("source_type missing (premium strictness)");
    }

    const sourceOk = reasons.length === 0;

    // Check creator (all tiers require verified creator)
    const creator = lesson.creator as Record<string, unknown> | undefined;
    if (!creator?.wallet_address) reasons.push("creator wallet missing");
    if (!creator?.is_verified) reasons.push("creator not verified");

    const creatorOk = !!creator?.wallet_address && !!creator?.is_verified;

    if (sourceOk && creatorOk) {
      verified.push({
        lesson_id: lessonId,
        order_index: selected.order_index as number,
        source_ok: true,
        creator_ok: true,
        verification_reason: `Source: ${source?.source_title || "verified"}, Creator verified [${config.sourceStrictness}]`,
      });
    } else {
      rejected.push({
        lesson_id: lessonId,
        reason: reasons.join("; "),
      });
    }
  }

  return {
    verifiedLessons: verified,
    rejectedLessons: rejected,
    allVerified: rejected.length === 0,
  };
}
