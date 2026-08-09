/**
 * Focused Query Builder authority diagnostics.
 * Run: npx tsx lib/paylabs/agent-services/__tests__/query-builder-authority.test.ts
 */

import {
  buildAuthoritativeLlmQueryBuilderData,
  queryBuilderHandler,
  runDeterministicQueryBuilder,
} from "../handlers/query-builder";
import { resolveContextualEntity } from "../../sources/crypto-entity-registry";

const Q4_GOAL =
  "Compare Uniswap and Curve as decentralized exchanges. How do their AMM designs, pricing mechanisms, liquidity models, LP fee economics, impermanent loss exposure, and MEV risks differ?";

const EXPECTED_ASPECTS = [
  "lp_fee_economics",
  "mev",
  "amm_design",
  "pricing_mechanism",
  "liquidity_model",
  "impermanent_loss",
];

const EXPECTED_PROTOCOLS = ["Uniswap", "Curve Finance"];

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function protocolEntities(value: unknown): Array<{ text: string; canonical: string; type: string; required: boolean }> {
  return (value as Array<{ text: string; canonical: string; type: string; required: boolean }>)
    .filter((entity) => entity.type === "protocol" && entity.required);
}

function expectPass(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${label}`);
    passed++;
  } catch (error) {
    console.log(`  ❌ ${label} — ${(error as Error).message}`);
    failed++;
  }
}

async function main(): Promise<void> {
  process.env.PAYLABS_AGENT_SERVICE_EXECUTION_MODE_QUERY_BUILDER = "deterministic";
  process.env.PAYLABS_AGENT_SERVICE_LLM_ENABLED_QUERY_BUILDER = "false";

  const deterministic = await queryBuilderHandler({
    discoveryRunId: "query-builder-authority-diagnostic",
    serviceName: "query_builder",
    payload: {
      user_goal: Q4_GOAL,
      intent_normalized_goal: "Compare Uniswap and Curve DEX mechanisms",
      topics: [],
    },
  });
  const deterministicData = deterministic.data as Record<string, unknown>;

  expectPass("deterministic path keeps exact Q4 protocol identities", () => {
    assert(
      JSON.stringify(protocolEntities(deterministicData.primary_entities)) === JSON.stringify([
        { text: "Uniswap", canonical: "Uniswap", type: "protocol", required: true },
        { text: "Curve", canonical: "Curve Finance", type: "protocol", required: true },
      ]),
      `unexpected protocol entities: ${JSON.stringify(protocolEntities(deterministicData.primary_entities))}`,
    );
    assert(
      !((deterministicData.primary_entities as Array<{ canonical: string; required: boolean }>)
        .some((entity) => entity.required && entity.canonical === "Curve")),
      "raw Curve must not remain a required canonical entity",
    );
  });

  expectPass("deterministic path keeps all requested aspects", () => {
    const actual = [...(deterministicData.requested_aspects as string[])].sort();
    assert(JSON.stringify(actual) === JSON.stringify([...EXPECTED_ASPECTS].sort()), `unexpected aspects: ${actual}`);
  });

  const deterministicOutput = runDeterministicQueryBuilder(Q4_GOAL, []);
  const simulatedLlmOutput = {
    primary_entities: deterministicOutput.primary_entities.map((entity) =>
      entity.canonical === "Curve Finance" ? { ...entity, canonical: "Curve" } : entity,
    ),
    secondary_entities: deterministicOutput.secondary_entities,
    topics: [],
    locked_phrases: deterministicOutput.locked_phrases,
    negative_entities: deterministicOutput.negative_entities,
    entity_terms: deterministicOutput.entity_terms,
    expanded_queries: ["Uniswap Curve comparison"],
    negative_filters: ["advertisement", "sponsored", "paywall"],
    source_preferences: ["credible", "recent"],
    safe_summary: "Built a comparison query.",
  };
  const simulatedFinal = buildAuthoritativeLlmQueryBuilderData(
    deterministicOutput,
    simulatedLlmOutput,
    EXPECTED_ASPECTS,
    [],
  );

  expectPass("simulated successful LLM cannot downgrade Curve Finance", () => {
    assert(
      JSON.stringify(protocolEntities(simulatedFinal.primary_entities)) === JSON.stringify([
        { text: "Uniswap", canonical: "Uniswap", type: "protocol", required: true },
        { text: "Curve", canonical: "Curve Finance", type: "protocol", required: true },
      ]),
      `LLM-downgraded output leaked through: ${JSON.stringify(protocolEntities(simulatedFinal.primary_entities))}`,
    );
    assert(
      (simulatedFinal.expanded_queries as string[]).some((query) => query.includes("Curve Finance")),
      `deterministic canonical query path missing: ${JSON.stringify(simulatedFinal.expanded_queries)}`,
    );
  });

  const negativeCurveQueries = [
    "Ethereum validator yield curve research",
    "bonding curve mechanics",
    "US Treasury yield curve",
  ];
  for (const query of negativeCurveQueries) {
    expectPass(`negative Curve context rejected: ${query}`, () => {
      assert(resolveContextualEntity("curve", query) === null, "unexpected Curve Finance resolution");
    });
  }

  const positiveCurveQueries = [
    "Compare Uniswap and Curve decentralized exchanges",
    "Curve AMM stablecoin liquidity",
    "Curve DEX stableswap pools",
  ];
  for (const query of positiveCurveQueries) {
    expectPass(`positive Curve context resolves: ${query}`, () => {
      assert(
        resolveContextualEntity("curve", query)?.canonical === "Curve Finance",
        "Curve Finance was not resolved",
      );
    });
  }

  for (const protocol of ["Aave", "Compound", "MakerDAO", "Uniswap", "Balancer"]) {
    expectPass(`existing protocol regression: ${protocol}`, () => {
      const output = runDeterministicQueryBuilder(`${protocol} protocol research`, []);
      assert(
        output.primary_entities.some((entity) => entity.canonical === protocol),
        `missing canonical ${protocol}: ${JSON.stringify(output.primary_entities)}`,
      );
    });
  }

  console.log(`\n─── Results: ${passed} passed, ${failed} failed ───`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
