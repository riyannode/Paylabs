import { supabaseAdmin } from "@/lib/paylabs/db/server";

export type PublicRunLifecycleStatus =
  | "created"
  | "awaiting_payment"
  | "payment_processing"
  | "paid"
  | "executing"
  | "completed"
  | "failed";

export function publicStatusFromRunStatus(status: unknown): PublicRunLifecycleStatus {
  if (status === "paid_path_available" || status === "discovery_only" || status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "payment_processing") return "payment_processing";
  if (status === "paid") return "paid";
  if (status === "executing") return "executing";
  if (status === "awaiting_payment") return "awaiting_payment";
  if (status === "created") return "created";
  return "created";
}

export async function updatePublicRunOrThrow(runId: string, values: Record<string, unknown>, context: string): Promise<Record<string, unknown>> {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .update(values)
    .eq("id", runId)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`${context}: ${error?.message || "no row returned"}`);
  }

  return data as Record<string, unknown>;
}

export async function claimPaymentProcessing(runId: string, signatureHash: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .update({
      status: "payment_processing",
      payment_signature_hash: signatureHash,
    })
    .eq("id", runId)
    .eq("status", "awaiting_payment")
    .is("payment_signature_hash", null)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`payment_claim_failed: ${error.message}`);
  }

  return data as Record<string, unknown> | null;
}

export async function claimExecution(runId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .update({ status: "executing" })
    .eq("id", runId)
    .in("status", ["paid", "payment_processing"])
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`execution_claim_failed: ${error.message}`);
  }

  return data as Record<string, unknown> | null;
}


export async function claimRoutingPaymentProcessing(runId: string, signatureHash: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .update({
      status: "payment_processing",
      routing_payment_signature_hash: signatureHash,
    })
    .eq("id", runId)
    .eq("status", "created")
    .is("routing_payment_signature_hash", null)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`routing_payment_claim_failed: ${error.message}`);
  }

  return data as Record<string, unknown> | null;
}
