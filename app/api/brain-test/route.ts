// Quick Brain planner LLM test endpoint (remove after verification)
import { NextResponse } from "next/server";

export const maxDuration = 30;

export async function GET() {
  try {
    const { resolveConfig, getTutorModel, getTutorModelConfig, getTutorModelName, isLlmRequired } = await import("@/lib/ai/llm");
    
    const agentName = "brain_planner";
    const cfg = resolveConfig(agentName);
    const modelConfig = getTutorModelConfig(agentName);
    const modelName = getTutorModelName(agentName);
    const model = getTutorModel(agentName);
    
    // Safe diagnostics (no secrets)
    const NATIVE_STRUCTURED_PROVIDERS = new Set(["openai", "anthropic", "mimo"]);
    const supportsNative = NATIVE_STRUCTURED_PROVIDERS.has(modelConfig.provider.toLowerCase());
    const structuredMode = supportsNative ? "llm_structured_native" : "llm_structured_json_extract";

    const runtimeConfig: Record<string, unknown> = {
      provider: modelConfig.provider,
      model: modelName,
      agentKey: modelConfig.agentKey,
      baseUrlPresent: !!modelConfig.baseUrl,
      baseUrlHost: modelConfig.baseUrl ? new URL(modelConfig.baseUrl).host : null,
      apiKeyPresent: modelConfig.apiKeyPresent,
      streaming: modelConfig.streaming,
      maxTokens: modelConfig.maxTokens,
      timeoutMs: modelConfig.timeoutMs,
      llmRequired: isLlmRequired(),
      modelAvailable: !!model,
      supportsNativeStructured: supportsNative,
      structuredMode,
    };
    
    if (!model) {
      return NextResponse.json({ ok: false, error: "No LLM model", runtimeConfig }, { status: 500 });
    }
    
    // Test direct invoke (raw, no structured output)
    const { HumanMessage, SystemMessage } = await import("@langchain/core/messages");
    const result = await model.invoke([
      new SystemMessage("Return ONLY a JSON object. No markdown. No commentary. The first character must be opening brace."),
      new HumanMessage("Return JSON: {\"ok\": true, \"test\": \"brain_planner_live\"}")
    ]);
    
    const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    
    return NextResponse.json({
      ok: true,
      runtimeConfig,
      responsePreview: content.slice(0, 500),
      responseLength: content.length,
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      errorSlice: (e instanceof Error ? e.message : String(e)).slice(0, 300),
    }, { status: 500 });
  }
}
