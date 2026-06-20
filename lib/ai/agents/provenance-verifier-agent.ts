/**
 * Agent 10: Provenance Verifier
 * Verify source identity and provenance from DB fields.
 */
import { z } from "zod";
import type { PayLabsTutorStateType } from "../state";
import { generateStructuredJson } from "../llm-structured";
import { getFeedItemById } from "../tools";

const Schema = z.object({
  provenance_results: z.array(z.object({
    feed_item_id: z.string(),
    provenance_ok: z.boolean(),
    missing_fields: z.array(z.string()),
    reasoning: z.string(),
  })),
});

const SYSTEM_PROMPT = `You are PayLabs Provenance Verifier Agent. Verify source identity and provenance from DB-provided fields. Check canonical URL presence, normalized hash, content hash, route id, route path, and route active status. You cannot invent hashes. You cannot invent URLs. You cannot set creator wallet. You cannot approve payment. Return structured JSON only.`;

export async function provenanceVerifierAgent(state: PayLabsTutorStateType) {
  const { selectedSources, routeTier } = state;
  const tier = routeTier || "normal";
  const selected = (selectedSources as Record<string, unknown>[]) || [];

  if (selected.length === 0) return { provenanceResults: [] };

  const sourceMeta: Record<string, unknown>[] = [];
  for (const s of selected) {
    try {
      const fi = await getFeedItemById(s.feed_item_id as string);
      const routeRaw = fi?.rsshub_route as unknown; const route = Array.isArray(routeRaw) ? routeRaw[0] as Record<string, unknown> : routeRaw as Record<string, unknown> | undefined;
      sourceMeta.push({
        feed_item_id: s.feed_item_id,
        canonical_url: fi?.canonical_url,
        normalized_sha256: fi?.normalized_sha256,
        content_sha256: fi?.content_sha256,
        route_id: route?.id,
        route_path: route?.route_path,
        route_is_active: route?.is_active,
      });
    } catch {
      sourceMeta.push({ feed_item_id: s.feed_item_id, error: "not found" });
    }
  }

  const result = await generateStructuredJson<z.infer<typeof Schema>>({
    agentName: "provenance_verifier",
    routeTier: tier,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Route: ${tier}\n\nSource provenance data:\n${JSON.stringify(sourceMeta, null, 2)}\n\nVerify provenance. Return structured JSON only.`,
    schema: Schema,
  });

  if (!result.ok) return { error: `Provenance verifier failed: ${result.error}`, llmErrors: { provenance_verifier: result }, provenanceResults: [] };

  return {
    provenanceResults: result.data.provenance_results,
    agentTrace: { provenance_verifier: result.meta },
    llmOutputs: { provenance_verifier: result.data },
    agentCallCounts: { provenance_verifier: 1 },
  };
}
