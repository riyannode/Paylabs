import { NextRequest, NextResponse } from "next/server";
import { getTutorModelConfig } from "@/lib/ai/llm";

const DEFAULT_GOAL =
  "Compare latest Arc x402 documentation, Circle Gateway documentation, and Circle DCW documentation. Include source-backed citations and receipt expectations.";

export async function POST(req: NextRequest) {
  // Fail closed if health token env is missing
  const expectedToken = process.env.PAYLABS_INTERNAL_HEALTH_TOKEN;
  if (!expectedToken) {
    return NextResponse.json({ ok: false, error: "Health endpoint not configured" }, { status: 503 });
  }

  // Verify Authorization header
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token || token !== expectedToken) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // Read optional goal from body
  let goal = DEFAULT_GOAL;
  try {
    const body = await req.json();
    if (body && typeof body.goal === "string" && body.goal.trim()) {
      goal = body.goal.trim();
    }
  } catch {
    // No body or invalid JSON — use default goal
  }

  try {
    const { runBrainPlannerGraph } = await import(
      "@/lib/paylabs/langgraph/brain/brain-planner-graph"
    );

    const discoveryRunId = `health-${crypto.randomUUID()}`;

    const result = await runBrainPlannerGraph({
      discoveryRunId,
      userGoal: goal,
      routeTier: "normal",
      userBudgetUsdc: 0.0001,
      userWallet: "0x0000000000000000000000000000000000000000",
    });

    const modelConfig = getTutorModelConfig("brain_planner");

    return NextResponse.json({
      ok: result.ok,
      model: modelConfig.model,
      provider: modelConfig.provider,
      agent_key: modelConfig.agentKey,
      max_tokens: modelConfig.maxTokens,
      timeout_ms: modelConfig.timeoutMs,
      route_tier_hint: "normal",
      selected_macro_nodes: result.selectedMacroNodes,
      selected_services_count: result.selectedServices.length,
      query_variants_count: result.progressSummaries.length,
      assistant_response_chars: result.finalSummary?.length ?? 0,
      user_visible_reasoning_chars: 0,
      error: result.error,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
