import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ChatOpenAI } = require("@langchain/openai");

// Brain planner config: 9router
const model = new ChatOpenAI({
  openAIApiKey: "sk-6b3...ca2f",
  modelName: "paylabs",
  temperature: 0.1,
  maxTokens: 1024,
  configuration: { baseURL: "http://43.156.160.127:20128/v1" },
  timeout: 15000,
});

console.log("Testing brain planner with 9router...");
console.log("Model:", model.modelName);
console.log("Base URL: http://43.156.160.127:20128/v1");

try {
  const result = await model.invoke([
    { role: "system", content: "You are a planning assistant. Respond with JSON only." },
    { role: "user", content: 'Analyze this goal and return JSON with fields: route_tier_hint (easy/normal/advanced), discovery_strategy (string), selected_services (array).\n\nGoal: "latest GitHub activity for riyannode/Paylabs repository"' },
  ]);
  
  console.log("\n=== Response ===");
  console.log("Type:", typeof result.content);
  console.log("Content:", typeof result.content === "string" ? result.content.slice(0, 500) : JSON.stringify(result.content).slice(0, 500));
  console.log("Response metadata:", result.response_metadata);
} catch (e) {
  console.log("Error:", e.message?.slice(0, 300));
}
