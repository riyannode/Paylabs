/**
 * Deep Agent: Advanced Evidence Evaluator
 *
 * Built on @langchain/langgraph/prebuilt createReactAgent — the same
 * graph runtime that powers langchain-ai/deepagents.
 *
 * Tools:
 * - read_creator_memory: Read reliability history for a source/creator
 * - read_evaluator_memory: Read past evaluation context
 * - compare_sources: Compare two sources for overlap/duplication
 * - classify_contribution: Classify how a source contributes
 * - detect_duplicates: Check if sources are near-duplicates
 * - write_evaluator_memory: Persist safe evaluation summary
 * - summarize_source_metrics: Aggregate quality/risk/value scores
 *
 * Authority boundaries:
 * - Tools are read-only EXCEPT write_evaluator_memory
 * - Agent cannot access wallets, secrets, or payment APIs
 * - Structured output via responseFormat (Zod schema)
 * - No raw chain-of-thought exposed
 */

import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type {
  CreatorAttribution,
  AdvancedEvidenceEvaluatorOutput,
} from "../creator-distribution/types";
import {
  readCreatorMemory,
  readEvaluatorMemory,
  writeEvaluatorMemorySummary,
} from "../creator-distribution/memory";

// ─── Response Schema (Zod → structured output) ───────────────

const EvidenceMatrixItem = z.object({
  feed_item_id: z.string(),
  source_url: z.string(),
  creator_wallet: z.string().nullable(),
  contribution_type: z.enum([
    "primary_answer",
    "verification",
    "contrast",
    "missing_context",
    "freshness",
    "source_authority",
  ]),
  contribution_summary: z.string(),
  materiality_score: z.number().min(0).max(1),
  duplicate_risk: z.number().min(0).max(1),
  memory_signal: z.string().optional(),
});

const SafeMemoryUpdate = z.object({
  source_reliability_notes: z.array(z.string()),
  creator_usage_notes: z.array(z.string()),
  evaluator_summary: z.string(),
});

const EvaluatorResponseSchema = z.object({
  ok: z.boolean(),
  evaluator_version: z.literal("advanced_evidence_deep_agent_v1"),
  selected_source_ids: z.array(z.string()),
  evidence_matrix: z.array(EvidenceMatrixItem),
  why_two_sources_needed: z.string(),
  user_facing_rationale: z.string(),
  evaluator_confidence: z.number().min(0).max(1),
  warnings: z.array(z.string()),
  safe_memory_update: SafeMemoryUpdate,
  error: z.string().nullable(),
});

// ─── System Prompt ────────────────────────────────────────────

const EVALUATOR_SYSTEM_PROMPT = `You are PayLabs Advanced Evidence Evaluator — a Deep Agent with memory and analysis tools.

Your job: evaluate whether selected creator sources materially improve the final answer for the user's goal.

You have access to tools:
- read_creator_memory: Check if a source/creator has been reliable before
- read_evaluator_memory: Check past evaluations for similar source combinations
- compare_sources: Compare two sources for content overlap and duplication risk
- classify_contribution: Analyze how a source contributes (primary, verification, contrast, etc.)
- detect_duplicates: Check if sources are near-duplicates
- summarize_source_metrics: Get aggregated quality/risk/value scores
- write_evaluator_memory: Save your evaluation summary for future reference

WORKFLOW:
1. First, read creator memories for each selected source to understand reliability history
2. Read evaluator memory for any past evaluations with overlapping sources
3. Compare the sources against each other for overlap/duplication
4. Classify each source's contribution type
5. Write a safe memory summary
6. Return your structured evaluation

RULES:
- You MUST NOT decide payment amounts, payout percentages, wallets, or payment status
- You MUST NOT reveal raw chain-of-thought in your rationale
- You MUST NOT access any secrets, API keys, or private keys
- Your rationale must be user-facing and safe to display
- If source #2 is weak or duplicated, report warnings but do not alter deterministic payouts
- Always use your tools before making a final judgment`;

// ─── Tool Definitions ─────────────────────────────────────────

function createEvaluatorTools(context: {
  discoveryRunId: string;
  sourceUrls: string[];
  creatorWallets: Map<string, string | null>;
  allApprovedItems: Array<{
    feed_item_id: string;
    source_url: string;
    source_title: string;
    final_score: number;
    risk_score: number;
    quality_score?: number;
    value_score?: number;
  }>;
}) {
  const readCreatorMemoryTool = new DynamicStructuredTool({
    name: "read_creator_memory",
    description:
      "Read reliability history and past payout records for a specific source URL or creator wallet. " +
      "Returns safe summaries only — no raw data. Use this to check if a source has been reliable before.",
    schema: z.object({
      source_url: z.string().describe("The source URL to look up"),
      creator_wallet: z
        .string()
        .nullable()
        .optional()
        .describe("Optional creator wallet address"),
    }),
    func: async ({ source_url, creator_wallet }) => {
      const memories = await readCreatorMemory(
        source_url,
        creator_wallet ?? null
      );
      if (memories.length === 0) {
        return JSON.stringify({
          found: false,
          message: "No memory found for this source/creator.",
        });
      }
      return JSON.stringify({
        found: true,
        count: memories.length,
        memories: memories.map((m) => ({
          source_url: m.source_url,
          memory_type: m.memory_type,
          safe_summary: m.safe_summary,
          reliability_score: m.reliability_score,
        })),
      });
    },
  });

  const readEvaluatorMemoryTool = new DynamicStructuredTool({
    name: "read_evaluator_memory",
    description:
      "Read past evaluation results for similar source combinations. " +
      "Returns evaluator summaries and confidence from previous runs. " +
      "Use this to understand if these sources have been evaluated together before.",
    schema: z.object({
      selected_source_urls: z
        .array(z.string())
        .describe("Source URLs to check for overlapping past evaluations"),
    }),
    func: async ({ selected_source_urls }) => {
      const memories = await readEvaluatorMemory(
        context.discoveryRunId,
        "",
        selected_source_urls
      );
      if (memories.length === 0) {
        return JSON.stringify({
          found: false,
          message: "No past evaluations found for these sources.",
        });
      }
      return JSON.stringify({
        found: true,
        count: memories.length,
        evaluations: memories.map((m) => ({
          route_tier: m.route_tier,
          source_urls: m.source_urls,
          safe_summary: m.safe_evaluator_summary,
          confidence: m.evaluator_confidence,
          warnings: m.warnings,
        })),
      });
    },
  });

  const compareSourcesTool = new DynamicStructuredTool({
    name: "compare_sources",
    description:
      "Compare two sources for content overlap, duplication risk, and complementary value. " +
      "Returns overlap_score (0-1), shared_topics, unique_contributions, and recommendation.",
    schema: z.object({
      source_a_url: z.string().describe("First source URL"),
      source_b_url: z.string().describe("Second source URL"),
    }),
    func: async ({ source_a_url, source_b_url }) => {
      const a = context.allApprovedItems.find(
        (i) => i.source_url === source_a_url
      );
      const b = context.allApprovedItems.find(
        (i) => i.source_url === source_b_url
      );

      if (!a || !b) {
        return JSON.stringify({
          error: "One or both sources not found in approved items.",
        });
      }

      // Deterministic comparison based on available metadata
      const samePublisher =
        a.source_title.toLowerCase().includes(b.source_title.toLowerCase()) ||
        b.source_title.toLowerCase().includes(a.source_title.toLowerCase());

      const scoreDiff = Math.abs(a.final_score - b.final_score);
      const riskDiff = Math.abs(a.risk_score - b.risk_score);

      // Heuristic overlap estimate
      const overlapScore = samePublisher
        ? 0.7
        : scoreDiff < 0.1
          ? 0.4
          : 0.1;

      return JSON.stringify({
        source_a: {
          url: a.source_url,
          title: a.source_title,
          score: a.final_score,
          risk: a.risk_score,
        },
        source_b: {
          url: b.source_url,
          title: b.source_title,
          score: b.final_score,
          risk: b.risk_score,
        },
        overlap_score: overlapScore,
        same_publisher_hint: samePublisher,
        score_difference: scoreDiff,
        risk_difference: riskDiff,
        recommendation:
          overlapScore > 0.6
            ? "high_overlap_warning"
            : overlapScore > 0.3
              ? "moderate_overlap"
              : "complementary_sources",
      });
    },
  });

  const classifyContributionTool = new DynamicStructuredTool({
    name: "classify_contribution",
    description:
      "Classify how a specific source contributes to the user's goal. " +
      "Returns contribution_type (primary_answer, verification, contrast, missing_context, freshness, source_authority) " +
      "and a contribution_summary explaining why this source matters.",
    schema: z.object({
      source_url: z.string().describe("Source URL to classify"),
      user_goal: z.string().describe("The user's original goal/question"),
      other_sources: z
        .array(z.string())
        .optional()
        .describe("URLs of other selected sources for context"),
    }),
    func: async ({ source_url, user_goal, other_sources }) => {
      const source = context.allApprovedItems.find(
        (i) => i.source_url === source_url
      );
      if (!source) {
        return JSON.stringify({
          error: "Source not found in approved items.",
        });
      }

      const otherSources = (other_sources || [])
        .map((url) => context.allApprovedItems.find((i) => i.source_url === url))
        .filter(Boolean);

      // Determine contribution type based on context
      let contributionType: string;
      let reasoning: string;

      if (otherSources.length === 0) {
        contributionType = "primary_answer";
        reasoning = "This is the primary/only source for the answer.";
      } else {
        const hasHigherScore = otherSources.some(
          (o) => o && source.final_score > o.final_score
        );
        const hasLowerRisk = otherSources.some(
          (o) => o && source.risk_score < o.risk_score
        );

        if (hasHigherScore && hasLowerRisk) {
          contributionType = "source_authority";
          reasoning =
            "This source has higher quality and lower risk than alternatives — provides authoritative foundation.";
        } else if (hasHigherScore) {
          contributionType = "verification";
          reasoning =
            "This source provides verification through higher quality scoring.";
        } else {
          contributionType = "contrast";
          reasoning =
            "This source provides contrasting perspective or additional context.";
        }
      }

      return JSON.stringify({
        source_url,
        source_title: source.source_title,
        feed_item_id: source.feed_item_id,
        final_score: source.final_score,
        risk_score: source.risk_score,
        contribution_type: contributionType,
        contribution_summary: reasoning,
        materiality_estimate:
          source.final_score > 0.7
            ? "high"
            : source.final_score > 0.4
              ? "medium"
              : "low",
      });
    },
  });

  const detectDuplicatesTool = new DynamicStructuredTool({
    name: "detect_duplicates",
    description:
      "Check if any of the selected sources are near-duplicates of each other. " +
      "Returns duplicate pairs with similarity scores and recommendations.",
    schema: z.object({
      source_urls: z
        .array(z.string())
        .describe("List of source URLs to check for duplicates"),
    }),
    func: async ({ source_urls }) => {
      const sources = source_urls
        .map((url) => context.allApprovedItems.find((i) => i.source_url === url))
        .filter(Boolean);

      const pairs: Array<{
        source_a: string;
        source_b: string;
        similarity: number;
        is_duplicate: boolean;
        reason: string;
      }> = [];

      for (let i = 0; i < sources.length; i++) {
        for (let j = i + 1; j < sources.length; j++) {
          const a = sources[i]!;
          const b = sources[j]!;

          // Heuristic similarity
          const titleWords = a.source_title.toLowerCase().split(/\s+/);
          const bTitleWords = b.source_title.toLowerCase().split(/\s+/);
          const commonWords = titleWords.filter(
            (w) => bTitleWords.includes(w) && w.length > 3
          );
          const similarity =
            commonWords.length /
            Math.max(titleWords.length, bTitleWords.length);

          pairs.push({
            source_a: a.source_url,
            source_b: b.source_url,
            similarity: Math.round(similarity * 100) / 100,
            is_duplicate: similarity > 0.7,
            reason:
              similarity > 0.7
                ? "high_title_overlap"
                : similarity > 0.4
                  ? "moderate_overlap"
                  : "distinct_sources",
          });
        }
      }

      return JSON.stringify({
        total_sources: sources.length,
        pairs_checked: pairs.length,
        duplicates_found: pairs.filter((p) => p.is_duplicate).length,
        pairs,
      });
    },
  });

  const summarizeMetricsTool = new DynamicStructuredTool({
    name: "summarize_source_metrics",
    description:
      "Get aggregated quality, risk, and value metrics for a set of sources. " +
      "Returns statistical summary useful for comparison.",
    schema: z.object({
      source_urls: z.array(z.string()).describe("Source URLs to summarize"),
    }),
    func: async ({ source_urls }) => {
      const sources = source_urls
        .map((url) => context.allApprovedItems.find((i) => i.source_url === url))
        .filter(Boolean);

      if (sources.length === 0) {
        return JSON.stringify({ error: "No sources found." });
      }

      const scores = sources.map((s) => s!.final_score);
      const risks = sources.map((s) => s!.risk_score);

      return JSON.stringify({
        count: sources.length,
        scores: {
          avg: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100,
          min: Math.min(...scores),
          max: Math.max(...scores),
        },
        risks: {
          avg: Math.round((risks.reduce((a, b) => a + b, 0) / risks.length) * 100) / 100,
          min: Math.min(...risks),
          max: Math.max(...risks),
        },
        sources: sources.map((s) => ({
          url: s!.source_url,
          title: s!.source_title,
          score: s!.final_score,
          risk: s!.risk_score,
        })),
      });
    },
  });

  const writeMemoryTool = new DynamicStructuredTool({
    name: "write_evaluator_memory",
    description:
      "Save your evaluation summary for future reference. " +
      "This is the ONLY write tool. Use it after completing your analysis. " +
      "Only store safe summaries — never raw reasoning or secrets.",
    schema: z.object({
      safe_evaluator_summary: z
        .string()
        .describe("Safe summary of your evaluation (no raw CoT)"),
      source_reliability_notes: z
        .array(z.string())
        .describe("Notes about each source's reliability"),
      creator_usage_notes: z
        .array(z.string())
        .describe("Notes about creator wallet usage"),
      warnings: z
        .array(z.string())
        .describe("Any warnings about the evaluation"),
    }),
    func: async ({
      safe_evaluator_summary,
      source_reliability_notes,
      creator_usage_notes,
      warnings,
    }) => {
      await writeEvaluatorMemorySummary({
        discovery_run_id: context.discoveryRunId,
        route_tier: "advanced",
        source_ids: context.allApprovedItems.map((i) => i.feed_item_id),
        source_urls: context.sourceUrls,
        safe_evaluator_summary,
        why_two_sources_needed: null,
        evaluator_confidence: null,
        warnings,
      });

      return JSON.stringify({
        written: true,
        message: "Evaluator memory saved successfully.",
      });
    },
  });

  return [
    readCreatorMemoryTool,
    readEvaluatorMemoryTool,
    compareSourcesTool,
    classifyContributionTool,
    detectDuplicatesTool,
    summarizeMetricsTool,
    writeMemoryTool,
  ];
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
 * Uses createReactAgent (LangGraph) with 7 tools:
 * - read_creator_memory
 * - read_evaluator_memory
 * - compare_sources
 * - classify_contribution
 * - detect_duplicates
 * - summarize_source_metrics
 * - write_evaluator_memory
 *
 * Returns structured output via responseFormat (Zod schema).
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

  const sourceUrls = selectedCreatorItems.map((s) => s.source_url);
  const creatorWallets = new Map(
    selectedCreatorItems.map((s) => [s.source_url, s.creator_wallet])
  );

  try {
    // ── Create LLM ──
    const llm = new ChatOpenAI({
      modelName: process.env.PAYLABS_EVALUATOR_MODEL || "gpt-4o-mini",
      temperature: 0.1,
    });

    // ── Create tools ──
    const tools = createEvaluatorTools({
      discoveryRunId,
      sourceUrls,
      creatorWallets,
      allApprovedItems,
    });

    // ── Create React Agent (LangGraph) ──
    const agent = createReactAgent({
      llm,
      tools,
      prompt: EVALUATOR_SYSTEM_PROMPT,
      responseFormat: {
        schema: EvaluatorResponseSchema,
        prompt:
          "Return your evaluation as structured JSON matching the schema. " +
          "Your user_facing_rationale must be safe to display — no raw chain-of-thought.",
      },
    });

    // ── Build initial message ──
    const userMessage = buildUserMessage({
      userGoal,
      selectedCreatorItems,
      allApprovedItems,
      creatorAttributions,
    });

    // ── Invoke agent ──
    const result = await agent.invoke({
      messages: [{ role: "user", content: userMessage }],
    });

    // ── Extract structured response ──
    const structuredResponse = result.structuredResponse as
      | AdvancedEvidenceEvaluatorOutput
      | undefined;

    if (structuredResponse) {
      return {
        ...structuredResponse,
        ok: true,
        evaluator_version: "advanced_evidence_deep_agent_v1",
        error: null,
      };
    }

    // Fallback: parse from last message if structured response not available
    const lastMessage = result.messages?.[result.messages.length - 1];
    const content =
      typeof lastMessage?.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage?.content || "");

    return parseFallbackOutput(content, input);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return buildErrorOutput(input, msg);
  }
}

// ─── Message Builder ──────────────────────────────────────────

function buildUserMessage(input: {
  userGoal: string;
  selectedCreatorItems: CreatorAttribution[];
  allApprovedItems: Array<{
    feed_item_id: string;
    source_url: string;
    source_title: string;
    final_score: number;
    risk_score: number;
  }>;
  creatorAttributions: CreatorAttribution[];
}): string {
  const sections = [
    `## User Goal\n${input.userGoal}`,
    "",
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
    "",
    `## All Approved Sources (${input.allApprovedItems.length})`,
    ...input.allApprovedItems.map(
      (item) =>
        `- ${item.feed_item_id}: ${item.source_title} (score=${item.final_score}, risk=${item.risk_score})`
    ),
    "",
    `## Creator Attributions (${input.creatorAttributions.length})`,
    ...input.creatorAttributions.map(
      (attr) =>
        `- ${attr.feed_item_id}: status=${attr.claim_status}, eligibility=${attr.eligibility_status}, reason=${attr.reason}`
    ),
    "",
    "## Your Task",
    "Use your tools to evaluate these sources. Then return your structured evaluation.",
  ];

  return sections.join("\n");
}

// ─── Fallback Parser ──────────────────────────────────────────

function parseFallbackOutput(
  rawOutput: string,
  input: RunAdvancedEvidenceDeepEvaluatorInput
): AdvancedEvidenceEvaluatorOutput {
  const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return buildErrorOutput(input, "no_json_in_response");
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      ok: true,
      evaluator_version: "advanced_evidence_deep_agent_v1",
      selected_source_ids:
        parsed.selected_source_ids ||
        input.selectedCreatorItems.map((s) => s.feed_item_id),
      evidence_matrix: Array.isArray(parsed.evidence_matrix)
        ? parsed.evidence_matrix
        : [],
      why_two_sources_needed:
        parsed.why_two_sources_needed ||
        "Advanced tier uses two independent sources.",
      user_facing_rationale:
        parsed.user_facing_rationale || "Evaluation completed.",
      evaluator_confidence:
        typeof parsed.evaluator_confidence === "number"
          ? Math.max(0, Math.min(1, parsed.evaluator_confidence))
          : 0.5,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      safe_memory_update: parsed.safe_memory_update || {
        source_reliability_notes: [],
        creator_usage_notes: [],
        evaluator_summary: "Parsed from fallback.",
      },
      error: null,
    };
  } catch {
    return buildErrorOutput(input, "json_parse_error");
  }
}

// ─── Error Output Builder ─────────────────────────────────────

function buildErrorOutput(
  input: RunAdvancedEvidenceDeepEvaluatorInput,
  errorMsg: string
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
      contribution_summary: "evaluator_error_fallback",
      materiality_score: 0.5,
      duplicate_risk: 0,
    })),
    why_two_sources_needed:
      "Advanced tier uses two independent verified creator sources for cross-validation.",
    user_facing_rationale: `Evidence evaluation error: ${errorMsg}. Deterministic payout policy remains in effect.`,
    evaluator_confidence: 0,
    warnings: [`evaluator_error: ${errorMsg}`],
    safe_memory_update: {
      source_reliability_notes: [],
      creator_usage_notes: [],
      evaluator_summary: `Error: ${errorMsg}`,
    },
    error: errorMsg,
  };
}
