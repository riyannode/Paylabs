/**
 * POST /api/paylabs/agent-services/source-verifier
 * Paid Source Verifier Agent Service endpoint.
 *
 * REQUIRES payment proof headers from Runner.
 * Without valid proof, returns 402 — no verification output.
 *
 * RFB 03: Agent-to-Agent Nanopayment Networks
 */

import { NextRequest, NextResponse } from "next/server";
import { runSourceVerification, type VerificationInput } from "@/lib/ai-tutor/source-verifier-service";
import { getRouteConfig, isValidRouteTier, type RouteTier } from "@/lib/ai-tutor/route-config";
import { getPromptsForRoute } from "@/lib/ai-tutor/route-prompts";
import { invokeJsonAgent } from "@/lib/ai-tutor/llm-json";
import { createHash } from "node:crypto";
import { z } from "zod";

const VerifierSchema = z.object({
  verification_notes: z.array(
    z.object({
      lesson_id: z.string(),
      source_reasoning: z.string(),
      creator_reasoning: z.string(),
      risk_flags: z.array(z.string()),
    })
  ),
});

type VerifierResult = z.infer<typeof VerifierSchema>;

const VALID_PROVIDER_ID = "paylabs-source-verifier-v1";

export async function POST(req: NextRequest) {
  try {
    // ── Payment proof validation (REQUIRED) ──
    const paymentId = req.headers.get("x-payment-id");
    const paymentRef = req.headers.get("x-payment-ref");
    const settlementRef = req.headers.get("x-settlement-ref");
    const proofInputHash = req.headers.get("x-input-hash");
    const proofProviderId = req.headers.get("x-provider-agent-id");

    if (!paymentId) {
      return NextResponse.json(
        { error: "Payment proof required: x-payment-id header missing" },
        { status: 402 }
      );
    }
    if (!paymentRef && !settlementRef) {
      return NextResponse.json(
        { error: "Payment proof required: x-payment-ref or x-settlement-ref header missing" },
        { status: 402 }
      );
    }
    if (proofProviderId !== VALID_PROVIDER_ID) {
      return NextResponse.json(
        { error: "Invalid provider agent ID" },
        { status: 403 }
      );
    }

    // ── Parse body ──
    const body = await req.json();
    const { route_tier, lessons, input_hash } = body;

    if (!route_tier || !isValidRouteTier(route_tier)) {
      return NextResponse.json(
        { error: "Invalid route_tier" },
        { status: 400 }
      );
    }

    if (!Array.isArray(lessons) || lessons.length === 0) {
      return NextResponse.json(
        { error: "lessons array required" },
        { status: 400 }
      );
    }

    // Verify input_hash is present and matches request body
    if (!proofInputHash) {
      return NextResponse.json(
        { error: "Payment proof required: x-input-hash header missing" },
        { status: 402 }
      );
    }
    const bodyHash = createHash("sha256")
      .update(JSON.stringify(lessons))
      .digest("hex");
    if (proofInputHash !== bodyHash) {
      return NextResponse.json(
        { error: "Input hash mismatch — proof does not match request body" },
        { status: 403 }
      );
    }

    const tier: RouteTier = route_tier;
    const config = getRouteConfig(tier);
    const prompts = getPromptsForRoute(tier);

    // Validate lessons have required safe metadata
    for (const lesson of lessons) {
      if (!lesson.lesson_id) {
        return NextResponse.json(
          { error: "Each lesson must have lesson_id" },
          { status: 400 }
        );
      }
    }

    // LLM reasoning (same as local source-verifier-agent)
    const lessonMeta = lessons.map((l: VerificationInput) => ({
      lesson_id: l.lesson_id,
      title: l.title,
      source_id: l.source_id,
      canonical_url: l.canonical_url,
      publisher: l.publisher,
      source_type: l.source_type,
      normalized_sha256: l.normalized_sha256,
      content_sha256: l.content_sha256,
      is_published: l.is_published,
      creator_wallet: l.creator_wallet,
      creator_verified: l.creator_verified,
    }));

    const llmResult = await invokeJsonAgent<VerifierResult>({
      agentName: "source_verifier_specialist",
      routeTier: tier,
      prompt: prompts.sourceVerifier,
      userMessage: `Route tier: ${tier}\nSource strictness: ${config.sourceStrictness}\n\nLesson metadata to verify (JSON):\n${JSON.stringify(lessonMeta, null, 2)}\n\nReview each lesson's source integrity and creator trustworthiness. Flag any concerns.`,
      schema: VerifierSchema,
    });

    // Collect LLM notes for enrichment
    const llmNotes: Record<string, { source: string; creator: string; flags: string[] }> = {};
    if (llmResult.ok) {
      const data = (llmResult as { ok: true; data: VerifierResult }).data;
      for (const note of data.verification_notes) {
        llmNotes[note.lesson_id] = {
          source: note.source_reasoning,
          creator: note.creator_reasoning,
          flags: note.risk_flags,
        };
      }
    }

    // Deterministic verification
    const result = runSourceVerification(lessons, config);

    // Enrich verified lessons with LLM notes
    const enrichedVerified = result.verified.map((v) => {
      const note = llmNotes[v.lesson_id];
      return {
        ...v,
        verification_reason: note?.flags?.length
          ? `${v.verification_reason} — LLM flags: ${note.flags.join(", ")}`
          : v.verification_reason,
      };
    });

    // Compute output hash
    const outputHash = createHash("sha256")
      .update(JSON.stringify({
        provider_agent_id: VALID_PROVIDER_ID,
        verified: enrichedVerified,
        rejected: result.rejected,
        all_verified: result.allVerified,
      }))
      .digest("hex");

    return NextResponse.json({
      ok: true,
      provider_agent_id: VALID_PROVIDER_ID,
      verified_lessons: enrichedVerified,
      rejected_lessons: result.rejected,
      verification_notes: llmNotes,
      output_hash: outputHash,
      payment_id: paymentId,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
