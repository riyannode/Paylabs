/**
 * Deep Agent: Advanced Evidence Evaluator
 *
 * Evaluates whether selected creator sources materially improve the final answer.
 * Uses LLM + memory for evidence evaluation ONLY.
 *
 * Authority boundaries:
 * - MAY use LLM + memory
 * - MAY call retrieval tools if available internally
 * - MUST return structured JSON
 * - MUST NOT return raw chain-of-thought
 * - MUST NOT choose wallet
 * - MUST NOT set payout amount
 * - MUST NOT set paid status
 * - MUST NOT generate settlement IDs
 * - MUST NOT bypass deterministic payout policy
 * - MUST NOT mutate split plan
 *
 * Implementation note: This is a LangGraph.js deep agent pattern
 * adapted from langchain-ai/deepagents middleware architecture.
 * The evaluator runs as a sub-graph within the settlement_memory macro-node.
 */

import { ChatOpenAI } from "@langchain/openai";
import type {
  CreatorAttribution,
  AdvancedEvidenceEvaluatorOutput,
} from "../creator-distribution/types";
import {
  readCreatorMemory,
  readEvaluatorMemory,
  writeEvaluatorMemorySummary,
} from "../creator-distribution/memory";

// ─── System Contract ──────────────────────────────────────────

const EVALUATOR_SYSTEM_PROMPT = `You are PayLabs Advanced Evidence Evaluator.
Your job is to evaluate whether the selected creator sources materially improve the final answer.
You may use safe memory and source metadata.
You must not decide payment amounts, payout percentages, wallets, payment status, settlement IDs, or tx hashes.
You must not reveal raw chain-of-thought.
Output only structured JSON matching AdvancedEvidenceEvaluatorOutput.
Explain why source #1 and source #2 are useful.
If source #2 is weak, duplicated, or not materially useful, return warnings, but do not alter deterministic payout amounts.`;

// ─── Read-Only Tools for Evaluator ────────────────────────────

interface EvaluatorToolContext {
  creatorMemories: Array<{
    source_url: string;
    safe_summary: string;
    reliability_score: number | null;
  }>;
  evaluatorMemories: Array<{
    safe_evaluator_summary: string;
    evaluator_confidence: number | null;
    warnings: string[];
  }>;
}

// ─── Deep Agent Evaluator ─────────────────────────────────────

export interface RunAdvancedEvidenceDeepEvaluatorInput {
  discoveryRunId: string;
  userGoal: string;
  selectedCreatorItems: CreatorAttribution[];
  allApprovedItems: Array<{
    feed_item_id: string;
    source_url: string;
    source_title: string;
    final_score: number;
    risk_score: number;
    quality_score?: number;
    value_score?: number;
    creator_wallet: string | null;
  }>;
  creatorAttributions: CreatorAttribution[];
  routeTier: "advanced";
}

/**
 * Run the Advanced Evidence Deep Evaluator.
 *
 * Uses LLM + memory to evaluate source contribution.
 * Returns structured JSON with evidence matrix and rationale.
 * Does NOT determine payout amounts or wallets.
 */
export async function runAdvancedEvidenceDeepEvaluator(
  input: RunAdvancedEvidenceDeepEvaluatorInput
): Promise<AdvancedEvidenceEvaluatorOutput> {
  const {
    discoveryRunId,
    userGoal,
    selectedCreatorItems,
    allApprovedItems,
    creatorAttributions,
  } = input;

  try {
    // ── Load memory (read-only tools) ──
    const sourceUrls = selectedCreatorItems.map((s) => s.source_url);
    const creatorMemories = [];
    const evaluatorMemories: EvaluatorToolContext["evaluatorMemories"] = [];

    for (const item of selectedCreatorItems) {
      const mem = await readCreatorMemory(
        item.source_url,
        item.creator_wallet
      );
      creatorMemories.push(
        ...mem.map((m) => ({
          source_url: m.source_url,
          safe_summary: m.safe_summary,
          reliability_score: m.reliability_score,
        }))
      );
    }

    const evalMem = await readEvaluatorMemory(
      discoveryRunId,
      userGoal,
      sourceUrls
    );
    evaluatorMemories.push(
      ...evalMem.map((m) => ({
        safe_evaluator_summary: m.safe_evaluator_summary,
        evaluator_confidence: m.evaluator_confidence,
        warnings: m.warnings,
      }))
    );

    // ── Build context for LLM ──
    const contextPayload = buildEvaluatorContext({
      userGoal,
      selectedCreatorItems,
      allApprovedItems,
      creatorAttributions,
      creatorMemories,
      evaluatorMemories,
    });

    // ── Call LLM for evidence evaluation ──
    const llm = new ChatOpenAI({
      modelName: process.env.PAYLABS_EVALUATOR_MODEL || "gpt-4o-mini",
      temperature: 0.1,
      maxTokens: 2000,
    });

    const response = await llm.invoke([
      { role: "system", content: EVALUATOR_SYSTEM_PROMPT },
      { role: "user", content: contextPayload },
    ]);

    const content =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    // ── Parse structured output ──
    const parsed = parseEvaluatorOutput(content, input);

    // ── Write safe memory (write tool) ──
    await writeEvaluatorMemorySummary({
      discovery_run_id: discoveryRunId,
      route_tier: "advanced",
      source_ids: selectedCreatorItems.map((s) => s.feed_item_id),
      source_urls: sourceUrls,
      safe_evaluator_summary: parsed.user_facing_rationale,
      why_two_sources_needed: parsed.why_two_sources_needed,
      evaluator_confidence: parsed.evaluator_confidence,
      warnings: parsed.warnings,
    });

    return parsed;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);

    // Fail-soft: return safe default without blocking payout
    return {
      ok: false,
      evaluator_version: "advanced_evidence_deep_agent_v1",
      selected_source_ids: selectedCreatorItems.map((s) => s.feed_item_id),
      evidence_matrix: selectedCreatorItems.map((item) => ({
        feed_item_id: item.feed_item_id,
        source_url: item.source_url,
        creator_wallet: item.creator_wallet,
        contribution_type: "primary_answer" as const,
        contribution_summary: "evaluator_error_fallback",
        materiality_score: 0.5,
        duplicate_risk: 0,
      })),
      why_two_sources_needed:
        "Advanced tier uses two independent verified creator sources for cross-validation.",
      user_facing_rationale:
        `Evidence evaluation encountered an error: ${msg}. Deterministic payout policy remains in effect.`,
      evaluator_confidence: 0,
      warnings: [`evaluator_error: ${msg}`],
      safe_memory_update: {
        source_reliability_notes: [],
        creator_usage_notes: [],
        evaluator_summary: `Error during evaluation: ${msg}`,
      },
      error: msg,
    };
  }
}

// ─── Context Builder ──────────────────────────────────────────

function buildEvaluatorContext(input: {
  userGoal: string;
  selectedCreatorItems: CreatorAttribution[];
  allApprovedItems: Array<{
    feed_item_id: string;
    source_url: string;
    source_title: string;
    final_score: number;
    risk_score: number;
    quality_score?: number;
    value_score?: number;
  }>;
  creatorAttributions: CreatorAttribution[];
  creatorMemories: Array<{
    source_url: string;
    safe_summary: string;
    reliability_score: number | null;
  }>;
  evaluatorMemories: Array<{
    safe_evaluator_summary: string;
    evaluator_confidence: number | null;
    warnings: string[];
  }>;
}): string {
  const sections = [
    `## User Goal\n${input.userGoal}`,
    `## Selected Creator Sources (${input.selectedCreatorItems.length})`,
    ...input.selectedCreatorItems.map(
      (item, i) =>
        `### Source ${i + 1}\n` +
        `- feed_item_id: ${item.feed_item_id}\n` +
        `- source_url: ${item.source_url}\n` +
        `- source_title: ${item.source_title}\n` +
        `- creator_wallet: ${item.creator_wallet || "none"}\n` +
        `- final_score: ${item.final_score}\n` +
        `- risk_score: ${item.risk_score}\n` +
        `- claim_status: ${item.claim_status}\n` +
        `- eligibility: ${item.eligibility_status}`
    ),
    `## All Approved Sources (${input.allApprovedItems.length})`,
    ...input.allApprovedItems.map(
      (item) =>
        `- ${item.feed_item_id}: ${item.source_title} (score=${item.final_score}, risk=${item.risk_score})`
    ),
    `## Creator Attributions (${input.creatorAttributions.length})`,
    ...input.creatorAttributions.map(
      (attr) =>
        `- ${attr.feed_item_id}: status=${attr.claim_status}, eligibility=${attr.eligibility_status}, reason=${attr.reason}`
    ),
  ];

  if (input.creatorMemories.length > 0) {
    sections.push(
      `## Creator Memory`,
      ...input.creatorMemories.map(
        (m) =>
          `- ${m.source_url}: ${m.safe_summary} (reliability: ${m.reliability_score ?? "unknown"})`
      )
    );
  }

  if (input.evaluatorMemories.length > 0) {
    sections.push(
      `## Prior Evaluator Memory`,
      ...input.evaluatorMemories.map(
        (m) =>
          `- ${m.safe_evaluator_summary} (confidence: ${m.evaluator_confidence ?? "unknown"})`
      )
    );
  }

  sections.push(
    `## Instructions`,
    `Evaluate whether these sources materially improve the final answer.`,
    `Return structured JSON with:`,
    `- evidence_matrix (per source: contribution_type, contribution_summary, materiality_score 0..1, duplicate_risk 0..1)`,
    `- why_two_sources_needed (string)`,
    `- user_facing_rationale (string, no raw CoT)`,
    `- evaluator_confidence (0..1)`,
    `- warnings (string[])`,
    `- safe_memory_update (source_reliability_notes, creator_usage_notes, evaluator_summary)`
  );

  return sections.join("\n");
}

// ─── Output Parser ────────────────────────────────────────────

function parseEvaluatorOutput(
  rawOutput: string,
  input: RunAdvancedEvidenceDeepEvaluatorInput
): AdvancedEvidenceEvaluatorOutput {
  // Try to extract JSON from the response
  const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return buildFallbackOutput(input, "no_json_in_response");
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    // Validate and normalize
    return {
      ok: true,
      evaluator_version: "advanced_evidence_deep_agent_v1",
      selected_source_ids:
        parsed.selected_source_ids ||
        input.selectedCreatorItems.map((s) => s.feed_item_id),
      evidence_matrix: Array.isArray(parsed.evidence_matrix)
        ? parsed.evidence_matrix.map(
            (m: Record<string, unknown>, i: number) => ({
              feed_item_id:
                m.feed_item_id || input.selectedCreatorItems[i]?.feed_item_id || "",
              source_url:
                m.source_url || input.selectedCreatorItems[i]?.source_url || "",
              creator_wallet:
                m.creator_wallet || input.selectedCreatorItems[i]?.creator_wallet || null,
              contribution_type: validateContributionType(m.contribution_type),
              contribution_summary:
                typeof m.contribution_summary === "string"
                  ? m.contribution_summary
                  : "no_summary",
              materiality_score: clamp01(m.materiality_score),
              duplicate_risk: clamp01(m.duplicate_risk),
              memory_signal:
                typeof m.memory_signal === "string" ? m.memory_signal : undefined,
            })
          )
        : input.selectedCreatorItems.map((item) => ({
            feed_item_id: item.feed_item_id,
            source_url: item.source_url,
            creator_wallet: item.creator_wallet,
            contribution_type: "primary_answer" as const,
            contribution_summary: "evaluator_default",
            materiality_score: 0.5,
            duplicate_risk: 0,
          })),
      why_two_sources_needed:
        typeof parsed.why_two_sources_needed === "string"
          ? parsed.why_two_sources_needed
          : "Advanced tier uses two independent verified creator sources for cross-validation.",
      user_facing_rationale:
        typeof parsed.user_facing_rationale === "string"
          ? parsed.user_facing_rationale
          : "Evidence evaluation completed.",
      evaluator_confidence: clamp01(parsed.evaluator_confidence),
      warnings: Array.isArray(parsed.warnings)
        ? parsed.warnings.filter((w: unknown) => typeof w === "string")
        : [],
      safe_memory_update: {
        source_reliability_notes: Array.isArray(
          parsed.safe_memory_update?.source_reliability_notes
        )
          ? parsed.safe_memory_update.source_reliability_notes
          : [],
        creator_usage_notes: Array.isArray(
          parsed.safe_memory_update?.creator_usage_notes
        )
          ? parsed.safe_memory_update.creator_usage_notes
          : [],
        evaluator_summary:
          typeof parsed.safe_memory_update?.evaluator_summary === "string"
            ? parsed.safe_memory_update.evaluator_summary
            : "Evaluation completed.",
      },
      error: null,
    };
  } catch {
    return buildFallbackOutput(input, "json_parse_error");
  }
}

function buildFallbackOutput(
  input: RunAdvancedEvidenceDeepEvaluatorInput,
  error: string
): AdvancedEvidenceEvaluatorOutput {
  return {
    ok: false,
    evaluator_version: "advanced_evidence_deep_agent_v1",
    selected_source_ids: input.selectedCreatorItems.map((s) => s.feed_item_id),
    evidence_matrix: input.selectedCreatorItems.map((item) => ({
      feed_item_id: item.feed_item_id,
      source_url: item.source_url,
      creator_wallet: item.creator_wallet,
      contribution_type: "primary_answer" as const,
      contribution_summary: "fallback",
      materiality_score: 0.5,
      duplicate_risk: 0,
    })),
    why_two_sources_needed:
      "Advanced tier uses two independent verified creator sources.",
    user_facing_rationale: `Evaluator fallback: ${error}`,
    evaluator_confidence: 0,
    warnings: [error],
    safe_memory_update: {
      source_reliability_notes: [],
      creator_usage_notes: [],
      evaluator_summary: `Fallback: ${error}`,
    },
    error,
  };
}

// ─── Helpers ──────────────────────────────────────────────────

function validateContributionType(
  val: unknown
): AdvancedEvidenceEvaluatorOutput["evidence_matrix"][number]["contribution_type"] {
  const valid = [
    "primary_answer",
    "verification",
    "contrast",
    "missing_context",
    "freshness",
    "source_authority",
  ];
  return valid.includes(val as string)
    ? (val as
        | "primary_answer"
        | "verification"
        | "contrast"
        | "missing_context"
        | "freshness"
        | "source_authority")
    : "primary_answer";
}

function clamp01(val: unknown): number {
  const n = typeof val === "number" ? val : Number(val);
  if (isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
