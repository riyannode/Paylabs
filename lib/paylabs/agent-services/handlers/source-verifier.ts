/**
 * Source Verifier Handler
 *
 * Reuses: source_quality_verifier
 * Macro-node: payment_decision
 * Requires LLM: yes
 *
 * Assesses source quality and credibility.
 */

import { z } from "zod";
import { generateStructuredJson } from "@/lib/ai/llm-structured";
import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";
import { toInternalRouteTier } from "./helpers";
import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";

const SourceVerifierSchema = z.object({
  quality_score: z.number().min(0).max(1),
  credibility_score: z.number().min(0).max(1),
  red_flags: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  safe_summary: z.string(),
});

const SYSTEM_PROMPT = `You are PayLabs Source Verifier. Assess the quality and credibility of a source. Check for red flags, domain authority, content freshness, and attribution clarity. You cannot set prices, wallets, or execute payments. Return structured JSON only. Always include a safe_summary field.`;

export const sourceVerifierHandler: ServiceHandler = async (
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> => {
  const { feed_item_id, source_url, source_title, routeTier } = input.payload as {
    feed_item_id: string;
    source_url: string;
    source_title: string;
    routeTier?: DelegatedRouteTier;
  };

  const result = await generateStructuredJson<z.infer<typeof SourceVerifierSchema>>({
    agentName: "source_verifier",
    routeTier: toInternalRouteTier(routeTier || "easy"),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Source ID: ${feed_item_id}\nURL: ${source_url}\nTitle: ${source_title}\n\nAssess quality and credibility. Return structured JSON only.`,
    schema: SourceVerifierSchema,
  });

  if (!result.ok) {
    return {
      ok: false,
      serviceName: "source_verifier",
      data: null,
      safeSummary: `Source verifier failed: ${result.error}`,
      settled: false,
      error: result.error,
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
