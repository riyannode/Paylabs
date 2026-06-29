// Temporary diagnostic: will be removed after verification
import { NextResponse } from "next/server";
export async function GET() {
  const { resolveConfig } = await import("@/lib/ai/llm");
  const cfg = resolveConfig("brain_planner");
  const forceNonStreamingBody = cfg.provider.toLowerCase() === "openai-compatible" || !!cfg.baseUrl;
  return NextResponse.json({
    provider: cfg.provider,
    providerLower: cfg.provider.toLowerCase(),
    baseUrlPresent: !!cfg.baseUrl,
    forceNonStreamingBody,
    apiKeyLen: cfg.apiKey?.length ?? 0,
    maxTokens: cfg.maxTokens,
    streaming: cfg.streaming,
    model: cfg.model,
    agentKey: cfg.agentKey,
  });
}
