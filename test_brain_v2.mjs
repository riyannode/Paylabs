import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { ChatOpenAI } = require("@langchain/openai");

const nrKey = readFileSync("/tmp/9router_key.txt", "utf8").trim();
const model = new ChatOpenAI({
  apiKey: nrKey, model: "paylabs", temperature: 0.1, maxTokens: 4096,
  configuration: { baseURL: "http://43.156.160.127:20128/v1" },
  timeout: 60000,
});

console.log("Testing with higher maxTokens...");
const start = Date.now();
try {
  const r = await model.invoke([
    { role: "system", content: "You are PayLabs Brain. Respond with valid JSON only, no markdown fences. Schema: {\"route_tier_hint\":\"easy|normal|advanced\",\"selected_services\":[\"intent_planner\",\"query_builder\",\"signal_scout\"],\"selected_macro_nodes\":[\"discovery_planner\"],\"safe_brain_summary\":\"string\",\"tier_decision_reason\":\"string\"}" },
    { role: "user", content: 'Goal: "latest GitHub activity for riyannode/Paylabs repository"\nBudget: 0.01 USDC\nRoute tier: auto\nReturn JSON:' },
  ]);
  const elapsed = Date.now() - start;
  const content = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
  console.log(`\nResponse (${elapsed}ms):`);
  console.log(content);
  console.log("\nTokens:", JSON.stringify(r.usage_metadata));
} catch (e) {
  console.log("Error:", e.message?.slice(0, 300));
}
