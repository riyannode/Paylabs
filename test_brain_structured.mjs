import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { ChatOpenAI } = require("@langchain/openai");
const { z } = require("zod");
const { zodToJsonSchema } = require("zod-to-json-schema");

const nrKey = readFileSync("/tmp/9router_key.txt", "utf8").trim();

const model = new ChatOpenAI({
  apiKey: nrKey,
  model: "paylabs",
  temperature: 0.1,
  maxTokens: 1024,
  configuration: { baseURL: "http://43.156.160.127:20128/v1" },
  timeout: 20000,
});

const BrainSchema = z.object({
  normalized_goal: z.string(),
  route_tier_hint: z.enum(["easy", "normal", "advanced"]),
  discovery_strategy: z.string(),
  suggested_query_variants: z.array(z.string()),
  selected_services: z.array(z.string()),
  selected_macro_nodes: z.array(z.string()),
  safe_brain_summary: z.string(),
  tier_decision_reason: z.string(),
});

const systemPrompt = `You are PayLabs Brain — the planning intelligence.
Analyze the user's request and produce a structured execution plan.
Respond with valid JSON matching the schema.`;

const userPrompt = `User goal: "latest GitHub activity for riyannode/Paylabs repository"
Budget: 0.01 USDC
Route tier: auto

Analyze and return JSON with:
- normalized_goal: cleaned up goal
- route_tier_hint: easy/normal/advanced
- discovery_strategy: how to find sources
- suggested_query_variants: search queries
- selected_services: which services to use
- selected_macro_nodes: which macro nodes
- safe_brain_summary: brief summary
- tier_decision_reason: why this tier`;

console.log("Testing brain planner structured output via 9router...\n");

// Strategy 1: Native structured output
try {
  console.log("Strategy 1: Native structured output...");
  const structuredModel = model.withStructuredOutput(BrainSchema);
  const result = await structuredModel.invoke([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);
  console.log("✅ Native structured output worked!");
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.log("❌ Native failed:", e.message?.slice(0, 200));
  
  // Strategy 2: Raw invoke + JSON extraction
  console.log("\nStrategy 2: Raw invoke + JSON extraction...");
  try {
    const schemaJson = JSON.stringify(zodToJsonSchema(BrainSchema), null, 2);
    const result = await model.invoke([
      { role: "system", content: systemPrompt + "\n\nRespond with JSON matching this schema:\n" + schemaJson },
      { role: "user", content: userPrompt },
    ]);
    const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    console.log("Raw response:", content.slice(0, 1000));
    
    // Extract JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const validated = BrainSchema.safeParse(parsed);
      if (validated.success) {
        console.log("\n✅ Parsed + validated!");
        console.log(JSON.stringify(validated.data, null, 2));
      } else {
        console.log("❌ Validation failed:", validated.error.issues);
      }
    }
  } catch (e2) {
    console.log("❌ Strategy 2 failed:", e2.message?.slice(0, 200));
  }
}
