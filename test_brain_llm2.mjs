import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { ChatOpenAI } = require("@langchain/openai");

// Read the 9router key from file
const nrKey = readFileSync("/tmp/9router_key.txt", "utf8").trim();

const model = new ChatOpenAI({
  openAIApiKey: nrKey,
  modelName: "paylabs",
  temperature: 0.1,
  maxTokens: 1024,
  configuration: { baseURL: "http://43.156.160.127:20128/v1" },
  timeout: 15000,
});

console.log("Testing brain planner LLM via 9router...");
console.log("Key len:", nrKey.length);

try {
  const result = await model.invoke([
    { role: "system", content: "You are PayLabs Brain planning assistant. Respond with valid JSON only." },
    { role: "user", content: `Analyze this goal and return JSON:
{
  "route_tier_hint": "easy|normal|advanced",
  "discovery_strategy": "string",
  "selected_services": ["service1", "service2"],
  "safe_brain_summary": "string"
}

Goal: "latest GitHub activity for riyannode/Paylabs repository"
Budget: 0.01 USDC` },
  ]);
  
  console.log("\n=== Brain LLM Response ===");
  const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  console.log(content.slice(0, 800));
  console.log("\nModel used:", result.response_metadata?.model || result.lc_kwargs?.response_metadata?.model);
  console.log("Token usage:", result.usage_metadata);
} catch (e) {
  console.log("Error:", e.message?.slice(0, 300));
}
