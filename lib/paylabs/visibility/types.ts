import type {
  DelegatedRouteTier,
  OrchestratorOutput,
  PaymentGraphEdge,
} from "@/lib/paylabs/delegated-runtime/types";

export type X402VisibilityMode = "x402" | "x402_failed" | "audit_only";

export interface WriteVisibilityInput {
  discoveryRunId: string;
  userWallet: string | null;
  routeTier: DelegatedRouteTier;
  result: OrchestratorOutput;
}

export function edgeMode(edge: PaymentGraphEdge): X402VisibilityMode {
  if (edge.mode === "x402" || edge.mode === "audit_only") return edge.mode;
  if (edge.status === "paid") return "x402";
  if (edge.status === "failed") return "x402_failed";
  return "audit_only";
}

export function safeEdgeStatus(edge: PaymentGraphEdge): string {
  if (edge.status === "paid") return "paid";
  if (edge.status === "failed") return "failed";
  if (edge.status === "skipped") return "skipped";
  return "audit_only";
}

export function sumPaidUsdc(edges: PaymentGraphEdge[]): number {
  return edges
    .filter((e) => e.status === "paid")
    .reduce((sum, e) => sum + e.amountUsdc, 0);
}

export function lastPaidTx(edges: PaymentGraphEdge[]): string | null {
  for (let i = edges.length - 1; i >= 0; i--) {
    if (edges[i].status === "paid" && edges[i].txHash) return edges[i].txHash!;
  }
  return null;
}

export function paidEdges(edges: PaymentGraphEdge[]): PaymentGraphEdge[] {
  return edges.filter((e) => e.status === "paid");
}
