import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ChatOpenAI } = require("@langchain/openai");

const nrKey = readFileSync("/tmp/9router_key.txt", "utf8").trim();
const model = new ChatOpenAI({
  apiKey: nrKey, model: "paylabs", temperature: 0.1, maxTokens: 4096,
  configuration: { baseURL: "http://43.156.160.127:20128/v1" },
  timeout: 30000,
});

// Quick raw invoke
const start = Date.now();
try {
  const r = await model.invoke([
    { role: "system", content: "You are PayLabs Brain. Respond with valid JSON only. Fields: route_tier_hint (easy/normal/advanced), selected_services (array), selected_macro_nodes (array), safe_brain_summary (string), tier_decision_reason (string). Use only these services: intent_planner, query_builder, signal_scout. Use only: discovery_planner." },
    { role: "user", content: 'Goal: "latest GitHub activity for riyannode/Paylabs repository"\nBudget: 0.01 USDC\nRoute tier: auto\nReturn JSON:' },
  ]);
  const elapsed = Date.now() - start;
  const content = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
  console.log(`Raw invoke: ${elapsed}ms`);
  console.log("Content:", content.slice(0, 500));
  console.log("Tokens:", JSON.stringify(r.usage_metadata));
} catch (e) {
  console.log("Error:", e.message?.slice(0, 200));
}
