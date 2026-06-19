/**
 * Agent 9: Source Quality Verifier
 * Evaluate selected sources for quality using DB metadata only.
 */
import { z } from "zod";
import type { PayLabsTutorStateType } from "../state";
import { generateStructuredJson } from "../llm-structured";
import { getFeedItemById } from "../tools";

const Schema = z.object({
  quality_results: z.array(z.object({
    feed_item_id: z.string(),
    quality_ok: z.boolean(),
    quality_score: z.number(),
    issues: z.array(z.string()),
    reasoning: z.string(),
  })),
});

const SYSTEM_PROMPT = `You are PayLabs Source Quality Verifier Agent. Evaluate the selected sources for quality using only DB-provided metadata. Check title, summary, publisher, author, publication date, and source completeness. You cannot verify creator ownership. You cannot set price. You cannot set wallet. You cannot approve payment. You cannot invent source metadata. Return structured JSON only.`;

export async function sourceQualityVerifierAgent(state: PayLabsTutorStateType) {
  const { selectedSources, routeTier } = state;
  const tier = routeTier || "normal";
  const selected = (selectedSources as Record<string, unknown>[]) || [];

  if (selected.length === 0) {
    return { sourceQualityResults: [], allVerified: false };
  }

  // Load full feed item metadata from DB
  const sourceMeta: Record<string, unknown>[] = [];
  for (const s of selected) {
    try {
      const fi = await getFeedItemById(s.feed_item_id as string);
      sourceMeta.push({
        feed_item_id: s.feed_item_id,
        title: fi?.title,
        summary: (fi?.summary as string || "").slice(0, 300),
        author_name: fi?.author_name,
        publisher: fi?.publisher,
        published_at: fi?.published_at,
        content_sha256: fi?.content_sha256,
        normalized_sha256: fi?.normalized_sha256,
      });
    } catch {
      sourceMeta.push({ feed_item_id: s.feed_item_id, error: "not found" });
    }
  }

  const result = await generateStructuredJson<z.infer<typeof Schema>>({
    agentName: "source_quality_verifier",
    routeTier: tier,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Route: ${tier}\n\nSource metadata to verify:\n${JSON.stringify(sourceMeta, null, 2)}\n\nEvaluate quality. Return structured JSON only.`,
    schema: Schema,
  });

  if (!result.ok) return { error: `Source quality verifier failed: ${result.error}`, llmErrors: { source_quality_verifier: result }, sourceQualityResults: [] };

  const allOk = result.data.quality_results.every(r => r.quality_ok);

  return {
    sourceQualityResults: result.data.quality_results,
    allVerified: allOk,
    agentTrace: { source_quality_verifier: result.meta },
    llmOutputs: { source_quality_verifier: result.data },
    agentCallCounts: { source_quality_verifier: 1 },
  };
}
