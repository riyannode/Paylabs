import { getTutorModel, getTutorModelConfig, isLlmRequired } from "../lib/ai/llm";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

async function testBrain() {
    console.log("=== Brain LLM Direct Test ===");
    
    const config = getTutorModelConfig("brain_planner");
    console.log("Config:", JSON.stringify({
        provider: config.provider,
        model: config.model,
        baseUrlPresent: !!config.baseUrl,
        baseUrlHost: config.baseUrl ? new URL(config.baseUrl).host : null,
        apiKeyPresent: config.apiKeyPresent,
        agentKey: config.agentKey,
        timeoutMs: config.timeoutMs,
        maxTokens: config.maxTokens,
    }));
    
    console.log("isLlmRequired:", isLlmRequired());
    
    const model = getTutorModel("brain_planner");
    console.log("Model obtained:", !!model);
    
    try {
        const result = await model.invoke([
            new SystemMessage("Return valid JSON only. No markdown. No explanation."),
            new HumanMessage('Return exactly this JSON: {"route_tier_hint":"easy","ok":true}'),
        ]);
        
        const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
        console.log("LLM Response length:", content.length);
        console.log("LLM Response preview:", content.slice(0, 500));
        
        let jsonStr = content;
        const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) jsonStr = fenceMatch[1].trim();
        
        const parsed = JSON.parse(jsonStr);
        console.log("JSON parsed:", true);
        console.log("route_tier_hint:", parsed.route_tier_hint);
    } catch (e: any) {
        console.log("EXCEPTION:", e.message?.slice(0, 500));
    }
}

testBrain().catch(e => console.error("Fatal:", e.message));
