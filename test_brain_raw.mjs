import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { ChatOpenAI } = require("@langchain/openai");

const nrKey = readFileSync("/tmp/9router_key.txt", "utf8").trim();
const model = new ChatOpenAI({
  apiKey: nrKey, model: "paylabs", temperature: 0.1, maxTokens: 512,
  configuration: { baseURL: "http://43.156.160.127:20128/v1" },
  timeout: 30000,
});

console.log("Raw invoke test (no structured output)...");
const start = Date.now();
try {
  const r = await model.invoke([
    { role: "system", content: "Respond with JSON only. Fields: route_tier_hint (easy/normal/advanced), selected_services (array of: intent_planner, query_builder, signal_scout), selected_macro_nodes (array of: discovery_planner)." },
    { role: "user", content: 'Goal: "latest GitHub activity for riyannode/Paylabs repository"\nReturn JSON:' },
  ]);
  const elapsed = Date.now() - start;
  const content = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
  console.log(`\nResponse (${elapsed}ms):`);
  console.log(content.slice(0, 600));
  console.log("\nTokens:", r.usage_metadata);
} catch (e) {
  console.log("Error:", e.message?.slice(0, 200));
}
