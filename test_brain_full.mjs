import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { ChatOpenAI } = require("@langchain/openai");
const { z } = require("zod");

const nrKey = readFileSync("/tmp/9router_key.txt", "utf8").trim();
const model = new ChatOpenAI({
  apiKey: nrKey, model: "paylabs", temperature: 0.1, maxTokens: 2048,
  configuration: { baseURL: "http://43.156.160.127:20128/v1" },
  timeout: 20000,
});

const BrainSchema = z.object({
  normalized_goal: z.string(),
  route_tier_hint: z.enum(["easy", "normal", "advanced"]),
  discovery_strategy: z.string(),
  suggested_query_variants: z.array(z.string()),
  selected_services: z.array(z.enum([
    "intent_planner","query_builder","signal_scout","intent_matcher",
    "source_verifier","value_allocator","trust_verifier","payment_decider","payment_router"
  ])),
  selected_macro_nodes: z.array(z.enum(["discovery_planner","payment_decision","settlement_memory"])),
  safe_brain_summary: z.string(),
  tier_decision_reason: z.string(),
});

const systemPrompt = `You are PayLabs Brain — the sole high-level planning intelligence.

Your role is PLAN-ONLY. You analyze the user's request, normalize the goal, recommend the route tier, create search query variants, and produce an advisory execution plan.

TIER SELECTION:
EASY macro nodes: ["discovery_planner"]
EASY services: ["intent_planner", "query_builder", "signal_scout"]

NORMAL macro nodes: ["discovery_planner", "payment_decision"]
NORMAL services: ["intent_planner", "query_builder", "signal_scout", "intent_matcher", "source_verifier", "value_allocator", "trust_verifier", "payment_decider"]

ADVANCED macro nodes: ["discovery_planner", "payment_decision", "settlement_memory"]
ADVANCED services: ["intent_planner", "query_builder", "signal_scout", "intent_matcher", "source_verifier", "value_allocator", "trust_verifier", "payment_decider", "payment_router"]

Use only these service names. Use only these macro node names.
If simple search/query, choose EASY. If comparison/verification, choose NORMAL. If paid access/payment, choose ADVANCED.`;

const userPrompt = `Goal: "latest GitHub activity for riyannode/Paylabs repository"
Budget: 0.01 USDC
Route tier: auto

Return JSON with normalized_goal, route_tier_hint, discovery_strategy, suggested_query_variants, selected_services, selected_macro_nodes, safe_brain_summary, tier_decision_reason.`;

console.log("Testing with constrained schema + full prompt...\n");
try {
  const structuredModel = model.withStructuredOutput(BrainSchema);
  const result = await structuredModel.invoke([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);
  console.log("✅ Result:");
  console.log(JSON.stringify(result, null, 2));
  
  // Validate
  const validServices = ["intent_planner","query_builder","signal_scout","intent_matcher","source_verifier","value_allocator","trust_verifier","payment_decider","payment_router"];
  const validMacros = ["discovery_planner","payment_decision","settlement_memory"];
  const badServices = result.selected_services?.filter(s => !validServices.includes(s));
  const badMacros = result.selected_macro_nodes?.filter(m => !validMacros.includes(m));
  
  if (badServices?.length) console.log("\n⚠️ Invalid services:", badServices);
  if (badMacros?.length) console.log("\n⚠️ Invalid macro nodes:", badMacros);
  if (!badServices?.length && !badMacros?.length) console.log("\n✅ All service/macro names valid!");
} catch (e) {
  console.log("Error:", e.message?.slice(0, 300));
}
