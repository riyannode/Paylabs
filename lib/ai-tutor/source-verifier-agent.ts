/**
 * Agent 3: Source Verifier Agent (LLM reasoning + deterministic decision)
 * Verifies planned lessons are real source-backed content.
 * No payment, no Runner — read-only.
 *
 * LLM reviews source metadata and gives reasoning, but final verification
 * is deterministic: source_id, canonical_url, hashes, published, creator.
 */

import type { PayLabsTutorStateType } from "./state";
import type { RouteTier } from "./route-config";
import { getRouteConfig } from "./route-config";
import { getPromptsForRoute } from "./route-prompts";
import { invokeJsonAgent } from "./llm-json";
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

// ─── Main agent ─────────────────────────────────────────────────

export async function sourceVerifierAgent(
  state: PayLabsTutorStateType
): Promise<Partial<PayLabsTutorStateType>> {
  const { selectedLessons, publishedLessons, routeTier, routePrompts } = state;
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

  // Call LLM for reasoning — NOT for final decision
  const llmResult = await invokeJsonAgent<VerifierResult>({
    agentName: "source_verifier",
    routeTier: tier,
    prompt: prompts.sourceVerifier,
    userMessage: `Route tier: ${tier}\nSource strictness: ${config.sourceStrictness}\n\nLesson metadata to verify (JSON):\n${JSON.stringify(lessonMeta, null, 2)}\n\nReview each lesson's source integrity and creator trustworthiness. Flag any concerns.`,
    schema: VerifierSchema,
  });

  // Collect LLM reasoning (audit trail)
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

  // ── DETERMINISTIC verification — final decision ──
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

    // ── High strictness (Advanced + Premium) ──
    if (config.sourceStrictness === "high" || config.sourceStrictness === "very_high") {
      if (!source?.publisher) reasons.push("publisher missing (high strictness)");
    }

    // ── Very high strictness (Premium) ──
    if (config.sourceStrictness === "very_high") {
      if (!source?.source_type) reasons.push("source_type missing (premium strictness)");
    }

    const sourceOk = reasons.length === 0;

    // Creator checks (all tiers)
    const creator = lesson.creator as Record<string, unknown> | undefined;
    if (!creator?.wallet_address) reasons.push("creator wallet missing");
    if (!creator?.is_verified) reasons.push("creator not verified");

    const creatorOk = !!creator?.wallet_address && !!creator?.is_verified;

    // Combine deterministic result with LLM reasoning
    const llmNote = llmNotes[lessonId];

    if (sourceOk && creatorOk) {
      verified.push({
        lesson_id: lessonId,
        order_index: selected.order_index as number,
        source_ok: true,
        creator_ok: true,
        verification_reason: `Source: ${source?.source_title || "verified"}, Creator verified [${config.sourceStrictness}]${llmNote?.flags?.length ? ` — LLM flags: ${llmNote.flags.join(", ")}` : ""}`,
      });
    } else {
      rejected.push({
        lesson_id: lessonId,
        reason: reasons.join("; "),
      });
    }
  }

  const trace = {
    ...llmMeta,
    deterministic_verified: verified.length,
    deterministic_rejected: rejected.length,
  };

  return {
    verifiedLessons: verified,
    rejectedLessons: rejected,
    allVerified: rejected.length === 0,
    agentTrace: { source_verifier: trace },
    ...(llmResult.ok ? { llmOutputs: { source_verifier: (llmResult as { data: unknown }).data } } : { llmErrors: { source_verifier: llmResult } }),
  };
}
