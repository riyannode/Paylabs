import { resolveConfig } from "../lib/ai/llm";

const cfg = resolveConfig("brain_planner");
const key = cfg.apiKey || "";
console.log("Key length:", key.length);
console.log("Key first 8:", key.slice(0, 8));
console.log("Key last 4:", key.slice(-4));
console.log("Key contains dash:", key.includes("-"));
console.log("Key starts with sk-:", key.startsWith("sk-"));
