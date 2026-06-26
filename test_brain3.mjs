import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { ChatOpenAI } = require("@langchain/openai");

const nrKey = readFileSync("/tmp/9router_key.txt", "utf8").trim();
console.log("Key length:", nrKey.length, "starts:", nrKey.slice(0,6));

// Try different param names
const model = new ChatOpenAI({
  apiKey: nrKey,
  model: "paylabs",
  temperature: 0.1,
  maxTokens: 1024,
  configuration: { baseURL: "http://43.156.160.127:20128/v1" },
  timeout: 15000,
});

console.log("Model created, invoking...");
try {
  const r = await model.invoke("say hello");
  console.log("Response:", typeof r.content === "string" ? r.content.slice(0, 200) : JSON.stringify(r.content).slice(0, 200));
} catch (e) {
  console.log("Error:", e.message?.slice(0, 300));
}
