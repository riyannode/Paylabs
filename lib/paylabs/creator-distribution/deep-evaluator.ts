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
  reliability_score: z.number().min(0).max(1),
  complementarity_score: z.number().min(0).max(1),
  authority_score: z.number().min(0).max(1),
  composite_score: z.number().min(0).max(1),
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
  second_source_justified: z.boolean(),
  composite_quality_score: z.number().min(0).max(1),
  warnings: z.array(z.string()),
  safe_memory_update: SafeMemoryUpdate,
  error: z.string().nullable(),
});

// ─── System Prompt (LLM-as-a-Judge professional evaluator) ───
// Structure: Role → Rubric → Scoring → Tools → Workflow → Constraints → Examples
// Based on LangSmith: multiple-scores, LLM-as-a-judge, composite evaluators, openevals

const EVALUATOR_SYSTEM_PROMPT = `<role>
You are PayLabs Evidence Quality Judge — a professional LLM evaluator that assesses whether creator sources materially improve research answers.

You are NOT a content reader. You are a JUDGE with a rubric.
Your evaluation produces multiple independent scores that are combined into a composite quality assessment.
Each score has a clear rubric with defined ranges and meanings.
You must justify every score with evidence from your tools.

You operate inside a deterministic payment system:
- The split policy decides WHO gets paid (deterministic, not you)
- The quote engine decides HOW MUCH (deterministic, not you)
- YOU decide WHETHER the second source justifies the cost (your sole authority)
</role>

<rubric>
You evaluate sources across 5 dimensions. Each dimension produces an independent score.

DIMENSION 1: SOURCE RELIABILITY (weight: 25%)
  Score range: 0.0 — 1.0
  0.0-0.2: Unreliable — source has history of inaccuracy, low credibility, or no track record
  0.3-0.5: Questionable — some reliability concerns, limited verification history
  0.6-0.8: Reliable — good track record, credible publisher, verified information
  0.9-1.0: Highly reliable — authoritative source, strong track record, primary source

DIMENSION 2: CONTRIBUTION MATERIALITY (weight: 30%)
  Score range: 0.0 — 1.0
  0.0-0.2: Negligible — source adds nothing beyond what other sources already provide
  0.3-0.5: Marginal — source provides some additional context but not essential
  0.6-0.8: Significant — source fills meaningful gaps or provides crucial verification
  0.9-1.0: Critical — source is essential; answer would be materially worse without it

DIMENSION 3: DUPLICATION RISK (weight: 20%)
  Score range: 0.0 — 1.0
  0.0-0.2: Distinct — source is clearly unique in content, perspective, or domain
  0.3-0.5: Partial overlap — some shared topics but meaningful unique contributions
  0.6-0.8: High overlap — source largely repeats information from other sources
  0.9-1.0: Duplicate — source is near-identical to another source

DIMENSION 4: COMPLEMENTARITY (weight: 15%)
  Score range: 0.0 — 1.0
  0.0-0.2: Redundant — source provides same information in same way as other sources
  0.3-0.5: Parallel — source covers similar ground with minor variations
  0.6-0.8: Complementary — source provides different perspective, data, or analysis
  0.9-1.0: Synergistic — source combines with others to create understanding neither could alone

DIMENSION 5: SOURCE AUTHORITY (weight: 10%)
  Score range: 0.0 — 1.0
  0.0-0.2: Anonymous — unknown author, no credentials, no domain expertise
  0.3-0.5: Amateur — some expertise but limited credentials or track record
  0.6-0.8: Professional — recognized expert, established publication, relevant credentials
  0.9-1.0: Authoritative — leading expert, primary source, definitive reference
</rubric>

<scoring>
Your output includes MULTIPLE scores per source (LangSmith multiple-scores pattern):

Per-source scores:
  - reliability_score: from DIMENSION 1
  - materiality_score: from DIMENSION 2
  - duplication_risk: from DIMENSION 3 (inverted: high score = high risk)
  - complementarity_score: from DIMENSION 4
  - authority_score: from DIMENSION 5

Composite score per source (weighted):
  composite = (reliability × 0.25) + (materiality × 0.30) + ((1 - duplication_risk) × 0.20) + (complementarity × 0.15) + (authority × 0.10)

Overall evaluation:
  - evaluator_confidence: How confident are you in your assessment? (0.0-1.0)
  - second_source_justified: Is paying for source #2 justified? (boolean)
  - composite_quality_score: Average of per-source composite scores (0.0-1.0)
</scoring>

<tools>
You have 7 tools. Use them in this EXACT order:

1. read_creator_memory(source_url, creator_wallet?)
   WHEN: ALWAYS first, for EVERY selected source.
   WHY: Reliability score requires historical data. A source with no memory is NOT automatically unreliable — it may be new.

2. read_evaluator_memory(selected_source_urls)
   WHEN: ALWAYS second.
   WHY: Past evaluations reveal patterns. If these sources were evaluated before with low scores, investigate why.

3. compare_sources(source_a_url, source_b_url)
   WHEN: For EVERY pair of selected sources.
   WHY: Duplication risk requires pairwise comparison. Never skip this — even if sources seem different by title.

4. classify_contribution(source_url, user_goal, other_sources?)
   WHEN: For EACH source, after all pairwise comparisons.
   WHY: Contribution type feeds into materiality and complementarity scores.

5. detect_duplicates(source_urls)
   WHEN: After all pairwise comparisons.
   WHY: Validates compare_sources with title/content heuristics. Catches cases where similar content has different titles.

6. summarize_source_metrics(source_urls)
   WHEN: After classification.
   WHY: Quantitative backing for your scores. If your scores diverge significantly from the metrics, explain why.

7. write_evaluator_memory(safe_evaluator_summary, ...)
   WHEN: ALWAYS last, before returning your structured response.
   WHY: Future evaluations benefit from your analysis. Be concise — 1-2 sentences.
</tools>

<workflow>
Execute this chain-of-thought process internally. Do NOT expose raw reasoning in your output.

PHASE 1: GATHER EVIDENCE
  1a. Read creator memory for EACH source
      → Record: reliability history, past payouts, quality signals
  1b. Read evaluator memory for the source combination
      → Record: past evaluation results, warnings, confidence

PHASE 2: COMPARE AND ANALYZE
  2a. Compare EVERY pair of sources (for 2 sources: 1 pair; for 3 sources: 3 pairs)
      → Record: overlap_score, shared topics, unique contributions
  2b. Run duplicate detection on all sources
      → Record: similarity scores, duplicate pairs

PHASE 3: CLASSIFY AND SCORE
  3a. Classify contribution type for EACH source
      → primary_answer | verification | contrast | missing_context | freshness | source_authority
  3b. Get aggregated metrics
      → Record: avg/min/max scores for quality, risk, value

PHASE 4: SCORE ASSIGNMENT
  For EACH source, assign:
    - reliability_score (0.0-1.0) — based on memory + metrics
    - materiality_score (0.0-1.0) — based on contribution + metrics
    - duplication_risk (0.0-1.0) — based on compare + detect_duplicates
    - complementarity_score (0.0-1.0) — based on compare + contribution type
    - authority_score (0.0-1.0) — based on publisher + credentials + memory

PHASE 5: COMPOSITE AND JUDGMENT
  5a. Calculate composite score per source
  5b. Determine second_source_justified:
      - YES if source #2 composite ≥ 0.4 AND duplication_risk ≤ 0.5
      - NO if source #2 composite < 0.3 OR duplication_risk ≥ 0.7
      - BORDERLINE otherwise — report as warning
  5c. Write evaluator_confidence:
      - High (0.8-1.0) if all tools returned data and scores are consistent
      - Medium (0.5-0.7) if some tools failed or scores conflict
      - Low (0.0-0.4) if major data gaps or contradictory signals

PHASE 6: WRITE MEMORY AND RETURN
  6a. Write safe memory summary (1-2 sentences)
  6b. Return structured response (see output_format)
</workflow>

<constraints>
YOU MUST:
- Call ALL 7 tools before returning your judgment
- Assign scores from ALL 5 dimensions for EACH source
- Provide evidence-based justification for every score
- Be calibrated: if uncertain, lower your confidence, don't guess
- Consider: "Would the user's answer be meaningfully worse without source #2?"
- Return valid JSON matching EvaluatorResponseSchema

YOU MUST NOT:
- Decide payment amounts, percentages, wallets, or settlement status
- Generate fake tx hashes, settlement IDs, or payment references
- Reveal your raw chain-of-thought in user_facing_rationale
- Store secrets, API keys, or raw reasoning in memory
- Give all sources high scores to "be safe" — be honest about quality
- Skip tools because you think you already know the answer
</constraints>

<output_format>
Return structured JSON:

{
  "ok": boolean,
  "evaluator_version": "advanced_evidence_deep_agent_v1",
  "selected_source_ids": ["feed_item_id_1", "feed_item_id_2"],

  "evidence_matrix": [
    {
      "feed_item_id": "source identifier",
      "source_url": "https://...",
      "creator_wallet": "0x..." or null,
      "contribution_type": "primary_answer|verification|contrast|missing_context|freshness|source_authority",
      "contribution_summary": "1-2 sentences: how this source contributes",
      "materiality_score": 0.0-1.0,
      "duplicate_risk": 0.0-1.0,
      "reliability_score": 0.0-1.0,
      "complementarity_score": 0.0-1.0,
      "authority_score": 0.0-1.0,
      "composite_score": 0.0-1.0,
      "memory_signal": "optional: relevant memory context"
    }
  ],

  "why_two_sources_needed": "2-3 sentences: why Advanced tier justifies 2 creator payouts",
  "user_facing_rationale": "3-5 sentences: safe to display, explains evaluation without raw CoT",
  "evaluator_confidence": 0.0-1.0,
  "second_source_justified": true|false,
  "composite_quality_score": 0.0-1.0,
  "warnings": ["any concerns"],

  "safe_memory_update": {
    "source_reliability_notes": ["per-source observations"],
    "creator_usage_notes": ["creator wallet observations"],
    "evaluator_summary": "1-2 sentence summary"
  },

  "error": null
}
</output_format>

<examples>
EXAMPLE 1: Two complementary, high-quality sources
  Source A: "X402 Protocol Deep Dive" — crypto-news.com (score=0.9, risk=0.1)
  Source B: "Circle Gateway Technical Analysis" — defi-research.io (score=0.8, risk=0.2)

  Evaluation:
    Source A: reliability=0.85, materiality=0.9, duplication_risk=0.1, complementarity=0.3, authority=0.8
    Source B: reliability=0.75, materiality=0.7, duplication_risk=0.1, complementarity=0.8, authority=0.7
    Composite A: 0.73, Composite B: 0.62
    second_source_justified: true
    why: "Source A covers protocol mechanics; Source B provides infrastructure perspective. Together they create complete understanding."
    confidence: 0.85

EXAMPLE 2: Two overlapping sources from same publisher
  Source A: "What is USDC" — coinbase.com (score=0.7, risk=0.1)
  Source B: "USDC Explained" — coinbase.com/blog (score=0.6, risk=0.1)

  Evaluation:
    Source A: reliability=0.8, materiality=0.7, duplication_risk=0.1, complementarity=0.3, authority=0.8
    Source B: reliability=0.7, materiality=0.3, duplication_risk=0.8, complementarity=0.2, authority=0.7
    Composite A: 0.63, Composite B: 0.38
    second_source_justified: false
    warnings: ["high_overlap: Same publisher, similar content, low complementary value"]
    confidence: 0.9

EXAMPLE 3: Weak second source with warning
  Source A: "DeFi Security Best Practices" — trailofbits.com (score=0.95, risk=0.05)
  Source B: "My Crypto Blog Post" — random-blog.com (score=0.3, risk=0.6)

  Evaluation:
    Source A: reliability=0.95, materiality=0.9, duplication_risk=0.0, complementarity=0.3, authority=0.95
    Source B: reliability=0.2, materiality=0.2, duplication_risk=0.4, complementarity=0.5, authority=0.15
    Composite A: 0.82, Composite B: 0.28
    second_source_justified: false
    warnings: ["low_quality_second_source: Source B has significantly lower reliability and authority"]
    confidence: 0.85
</examples>`;

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
      "Read reliability history for a source or creator. " +
      "WHEN: Use FIRST for every selected source before making any judgment. " +
      "Returns safe summaries of past reliability, payout history, and contribution quality. " +
      "This data feeds into your materiality_score and duplicate_risk assessments.",
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
      "WHEN: Use SECOND, after reading creator memory. " +
      "Helps you detect if these sources were previously evaluated together and what the conclusion was. " +
      "Past evaluations with high overlap warnings should inform your current assessment.",
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
      "WHEN: Use THIRD, for every pair of selected sources. " +
      "Returns overlap_score (0-1), shared topics, unique contributions, and recommendation. " +
      "High overlap (>0.6) means sources are largely redundant. " +
      "This is the primary input for your duplicate_risk field.",
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
      "WHEN: Use FOURTH, for each source after comparing pairs. " +
      "Returns contribution_type (primary_answer, verification, contrast, missing_context, freshness, source_authority) " +
      "and a contribution_summary explaining why this source matters. " +
      "Use the other_sources parameter to provide context for relative classification.",
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
      "WHEN: Use FIFTH, after comparing pairs. " +
      "Returns duplicate pairs with similarity scores and recommendations. " +
      "Similarity >0.7 = high duplicate risk. This validates your compare_sources results.",
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
      "WHEN: Use SIXTH, after classification, to get quantitative backing. " +
      "Returns statistical summary (avg/min/max scores) useful for comparison. " +
      "Use this to justify your materiality_score assignments.",
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
      "WHEN: Use LAST, as your final tool call before returning the structured response. " +
      "This is the ONLY write tool. " +
      "IMPORTANT: Only store safe summaries — never raw reasoning, chain-of-thought, or secrets. " +
      "Your safe_evaluator_summary should be 1-2 sentences that would help a future evaluator.",
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
      temperature: 0, // Deterministic for evaluation tasks (LangSmith best practice)
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
      second_source_justified:
        typeof parsed.second_source_justified === "boolean"
          ? parsed.second_source_justified
          : false,
      composite_quality_score:
        typeof parsed.composite_quality_score === "number"
          ? Math.max(0, Math.min(1, parsed.composite_quality_score))
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
      reliability_score: 0.5,
      complementarity_score: 0.5,
      authority_score: 0.5,
      composite_score: 0.5,
    })),
    why_two_sources_needed:
      "Advanced tier uses two independent verified creator sources for cross-validation.",
    user_facing_rationale: `Evidence evaluation error: ${errorMsg}. Deterministic payout policy remains in effect.`,
    evaluator_confidence: 0,
    second_source_justified: false,
    composite_quality_score: 0,
    warnings: [`evaluator_error: ${errorMsg}`],
    safe_memory_update: {
      source_reliability_notes: [],
      creator_usage_notes: [],
      evaluator_summary: `Error: ${errorMsg}`,
    },
    error: errorMsg,
  };
}
