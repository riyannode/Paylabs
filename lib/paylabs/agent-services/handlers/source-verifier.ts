/**
 * Source Verifier Handler
 *
 * Reuses: source_quality_verifier
 * Macro-node: payment_decision
 * Execution modes:
 *   - deterministic (default): URL/domain/metadata validation, DB flags
 *   - llm: LLM-powered quality assessment
 *   - hybrid: deterministic checks + LLM quality explanation
 *
 * Assesses source quality and credibility.
 */

import { z } from "zod";
import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";
import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";
import { shouldRunServiceAsDeterministic } from "../execution-mode";

const SourceVerifierSchema = z.object({
  quality_score: z.number().min(0).max(1),
  credibility_score: z.number().min(0).max(1),
  red_flags: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  safe_summary: z.string(),
});

// ─── Deterministic Source Verification ──────────────────────

const TRUSTED_DOMAINS = new Set([
  "arxiv.org", "github.com", "nature.com", "science.org",
  "ieee.org", "acm.org", "reuters.com", "apnews.com",
  "bbc.com", "bbc.co.uk", "nytimes.com", "washingtonpost.com",
  "theguardian.com", "economist.com", "wired.com", "arstechnica.com",
  "techcrunch.com", "verge.com", "medium.com", "substack.com",
]);

const SUSPICIOUS_PATTERNS = [
  /bit\.ly|tinyurl|goo\.gl/i,  // URL shorteners
  /\.xyz$|\.top$|\.click$/i,    // suspicious TLDs
  /ad[s]?[\.\-]/i,              // ad domains
  /clickbait|spam|fake/i,        // obvious red flags
];

function runDeterministicSourceVerifier(
  sourceUrl: string,
  sourceTitle: string,
  feedItemId?: string
): {
  quality_score: number;
  credibility_score: number;
  red_flags: string[];
  confidence: number;
} {
  const redFlags: string[] = [];
  let qualityScore = 0.5; // neutral baseline
  let credibilityScore = 0.5;

  // URL validation
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return {
      quality_score: 0,
      credibility_score: 0,
      red_flags: ["Invalid URL format"],
      confidence: 0.9,
    };
  }

  // Protocol check
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    redFlags.push("Non-HTTP protocol");
    qualityScore -= 0.3;
  }

  // HTTPS bonus
  if (url.protocol === "https:") {
    credibilityScore += 0.1;
  }

  // Domain trust
  const domain = url.hostname.replace(/^www\./, "").toLowerCase();
  if (TRUSTED_DOMAINS.has(domain)) {
    credibilityScore += 0.3;
    qualityScore += 0.2;
  }

  // Suspicious patterns
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(sourceUrl) || pattern.test(domain)) {
      redFlags.push(`Suspicious pattern: ${pattern.source}`);
      qualityScore -= 0.2;
      credibilityScore -= 0.2;
    }
  }

  // Title quality signals
  if (sourceTitle) {
    const titleLen = sourceTitle.length;
    if (titleLen < 10) {
      redFlags.push("Very short title");
      qualityScore -= 0.1;
    }
    if (titleLen > 200) {
      redFlags.push("Very long title");
      qualityScore -= 0.05;
    }
    // ALL CAPS title
    if (sourceTitle === sourceTitle.toUpperCase() && sourceTitle.length > 5) {
      redFlags.push("ALL CAPS title");
      qualityScore -= 0.1;
    }
  }

  // Feed item ID present = exists in DB
  if (feedItemId) {
    credibilityScore += 0.1;
  }

  // Clamp scores
  qualityScore = Math.max(0, Math.min(1, qualityScore));
  credibilityScore = Math.max(0, Math.min(1, credibilityScore));

  // Confidence based on how many checks we could run
  const confidence = redFlags.length === 0 ? 0.7 : 0.5;

  return {
    quality_score: Math.round(qualityScore * 100) / 100,
    credibility_score: Math.round(credibilityScore * 100) / 100,
    red_flags: redFlags,
    confidence,
  };
}

// ─── Handler ────────────────────────────────────────────────

export const sourceVerifierHandler: ServiceHandler = async (
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> => {
  const routeTier = (input.payload as { routeTier?: DelegatedRouteTier }).routeTier;

  // ── Batch mode: payload.candidates is an array ──
  const candidates = (input.payload as { candidates?: Array<{ feed_item_id: string; source_url: string; source_title: string }> }).candidates;
  if (Array.isArray(candidates)) {
    const results: Array<{ feed_item_id: string; quality_score: number; credibility_score: number; red_flags: string[]; confidence: number; safe_quality_summary: string }> = [];
    for (const c of candidates) {
      const det = runDeterministicSourceVerifier(c.source_url || "", c.source_title || "", c.feed_item_id);
      results.push({
        feed_item_id: c.feed_item_id,
        quality_score: det.quality_score,
        credibility_score: det.credibility_score,
        red_flags: det.red_flags,
        confidence: det.confidence,
        safe_quality_summary: `Quality: ${det.quality_score}, credibility: ${det.credibility_score}, flags: ${det.red_flags.length}. Deterministic.`,
      });
    }
    const summary = `Source Verifier batch: ${results.length} candidates processed, ${results.filter(r => r.quality_score >= 0.5).length} above threshold.`;
    return {
      ok: true,
      serviceName: "source_verifier",
      data: { results },
      safeSummary: summary,
      settled: false,
      error: null,
    };
  }

  // ── Single-item mode (backward compatible) ──
  const { feed_item_id, source_url, source_title } = input.payload as {
    feed_item_id: string;
    source_url: string;
    source_title: string;
  };

  // Deterministic mode (default)
  if (shouldRunServiceAsDeterministic("source_verifier")) {
    const det = runDeterministicSourceVerifier(
      source_url || "",
      source_title || "",
      feed_item_id
    );
    return {
      ok: true,
      serviceName: "source_verifier",
      data: {
        quality_score: det.quality_score,
        credibility_score: det.credibility_score,
        red_flags: det.red_flags,
        confidence: det.confidence,
        safe_quality_summary: `Quality: ${det.quality_score}, credibility: ${det.credibility_score}, flags: ${det.red_flags.length}. Deterministic verification.`,
      },
      safeSummary: `Quality: ${det.quality_score}, credibility: ${det.credibility_score}, flags: ${det.red_flags.length}. Deterministic verification.`,
      settled: false,
      error: null,
    };
  }

  // LLM mode
  const { generateStructuredJson } = await import("@/lib/ai/llm-structured");
  const { toInternalRouteTier } = await import("./helpers");

  const SYSTEM_PROMPT = `You are PayLabs Source Verifier.
Your task is to assess source quality and credibility from provided metadata.
Use only:
feed_item_id
source_url
source_title
publisher if provided
claim_status if provided
You do not browse. You do not fetch external pages. You do not invent source content. You do not set prices. You do not choose wallets. You do not execute payments. You do not settle payments.
Evaluate:
URL validity
domain/source clarity
title quality
obvious red flags
attribution clarity from provided metadata only
Do not claim a source is true or false unless the provided metadata supports it. Do not expose raw internals.
safe_summary must be 1 short sentence.
Return JSON only. No markdown. No commentary. No extra keys. The first character must be "{".`;

  const result = await generateStructuredJson<z.infer<typeof SourceVerifierSchema>>({
    agentName: "source_verifier",
    routeTier: toInternalRouteTier(routeTier || "easy"),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Source ID: ${feed_item_id}\nURL: ${source_url}\nTitle: ${source_title}\n\nAssess quality and credibility. Return structured JSON only.`,
    schema: SourceVerifierSchema,
  });

  if (!result.ok) {
    // Fallback: deterministic
    const det = runDeterministicSourceVerifier(
      source_url || "",
      source_title || "",
      feed_item_id
    );
    return {
      ok: true,
      serviceName: "source_verifier",
      data: {
        quality_score: det.quality_score,
        credibility_score: det.credibility_score,
        red_flags: det.red_flags,
        confidence: det.confidence,
        safe_quality_summary: `Quality: ${det.quality_score}, credibility: ${det.credibility_score} (LLM failed, deterministic fallback).`,
      },
      safeSummary: `Quality: ${det.quality_score}, credibility: ${det.credibility_score} (LLM failed, deterministic fallback).`,
      settled: false,
      error: null,
    };
  }

  return {
    ok: true,
    serviceName: "source_verifier",
    data: {
      quality_score: result.data.quality_score,
      credibility_score: result.data.credibility_score,
      red_flags: result.data.red_flags,
      confidence: result.data.confidence,
      safe_quality_summary: result.data.safe_summary,
    },
    safeSummary: result.data.safe_summary,
    settled: false,
    error: null,
  };
};
