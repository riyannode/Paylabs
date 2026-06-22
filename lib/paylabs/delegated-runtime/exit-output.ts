import type {
  OrchestratorOutput,
  PaymentGraphEdge,
  TieredRunSummaries,
} from "@/lib/paylabs/delegated-runtime/types";

export type ExitOutput = {
  selected_tier: string;
  phases_completed: string[];

  easy_summary?: string;
  normal_summary?: string;
  advanced_summary?: string;
  final_summary: string;

  services_paid: number;
  payment_edges_paid: number;
  payment_edges_failed: number;
  actual_settled_usdc: number;
  remaining_budget_usdc: number | null;
  receipt_ready: boolean;
};

function sumPaid(edges: PaymentGraphEdge[]): number {
  return edges
    .filter((edge) => edge.status === "paid")
    .reduce((sum, edge) => sum + Number(edge.amountUsdc || 0), 0);
}

export function buildExitOutput(result: OrchestratorOutput): ExitOutput {
  const graph = result.paymentGraph || [];
  const summaries = result.tieredSummaries || ({} as TieredRunSummaries);

  const paidEdges = graph.filter((edge) => edge.status === "paid");
  const failedEdges = graph.filter((edge) => edge.status === "failed");
  const servicePaid = paidEdges.filter((edge) => edge.nodeType === "service").length;
  const actualSettled = sumPaid(graph);

  return {
    selected_tier: result.routeTier,
    phases_completed: result.phasesCompleted || [],

    easy_summary: summaries.easy_summary,
    normal_summary: summaries.normal_summary,
    advanced_summary: summaries.advanced_summary,
    final_summary:
      summaries.final_summary ||
      result.safeProgressSummaries?.join(" | ") ||
      "PayLabs run completed.",

    services_paid: servicePaid,
    payment_edges_paid: paidEdges.length,
    payment_edges_failed: failedEdges.length,
    actual_settled_usdc: actualSettled,
    remaining_budget_usdc:
      result.budgetSnapshot?.remainingUsdc ??
      result.budgetSnapshot?.remainingBudgetUsdc ??
      null,
    receipt_ready: result.status === "completed" && paidEdges.length > 0,
  };
}
