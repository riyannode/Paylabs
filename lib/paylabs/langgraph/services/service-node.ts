/**
 * LangGraph Service Node Wrapper
 *
 * Wraps a delegated service call as a LangGraph node function.
 * All macro-node graphs use this to call child services via callDelegatedService().
 *
 * Rules:
 * - Must NOT sign payments
 * - Must NOT settle payments
 * - Must NOT call SERVICE_HANDLERS directly
 * - Only calls callDelegatedService()
 * - Records service evaluation + budget snapshot into state
 */

import { callDelegatedService } from "../../agent-services/call-delegated-service";
import type { ServiceName } from "../../agent-services/types";
import type { ServiceEvaluation, PaymentEdge } from "../../delegated-runtime/types";
import { randomUUID } from "node:crypto";

// ─── Types ──────────────────────────────────────────────────

type ServiceNodeResult = {
  serviceEvaluations: ServiceEvaluation[];
  paymentEdges: PaymentEdge[];
  progressSummaries: string[];
  budgetDelta: { serviceName: ServiceName; costUsdc: number; settled: boolean };
  handlerData: Record<string, unknown> | null;
};

// ─── Service Node Factory ───────────────────────────────────

/**
 * Create a LangGraph node that calls a delegated service.
 *
 * @param serviceName - The service to call
 * @param macroNode - Parent macro-node name (buyer in payment graph)
 * @param payloadFn - Function to build the payload from current state
 * @param options - Additional options
 */
export function createServiceNode(
  serviceName: ServiceName,
  macroNode: string,
  payloadFn: (state: Record<string, unknown>) => Record<string, unknown>,
  options?: {
    paymentLayer?: "macro_to_child";
    paymentSchemeOverride?: "circle_gateway_wallet_batched" | "circle_gateway_wallet_batched_grouped_child" | "circle_gateway_wallet_batched_per_child_fallback";
  }
): (state: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async (state: Record<string, unknown>) => {
    // Cast state properties (LangGraph passes full state as Record<string, unknown>)
    const discoveryRunId = state.discoveryRunId as string;
    const parentWalletId = state.parentWalletId as string | undefined;
    const selectedServices = state.selectedServices as string[] | undefined;

    // Check if this service is in the selected services list
    const selected = selectedServices;
    if (selected && selected.length > 0 && !selected.includes(serviceName)) {
      const summary = `${macroNode} → ${serviceName}: skipped (not in execution plan)`;
      return {
        progressSummaries: [summary],
        _serviceResult: {
          serviceEvaluations: [{
            serviceName,
            macroNode: macroNode as ServiceEvaluation["macroNode"],
            input: {},
            output: null,
            safeSummary: summary,
            status: "skipped",
            costUsdc: 0,
            startedAt: null,
            completedAt: null,
            error: null,
            settled: false,
            mode: "audit_only",
          }],
          paymentEdges: [],
          progressSummaries: [summary],
          budgetDelta: { serviceName, costUsdc: 0, settled: false },
          handlerData: null,
        },
      };
    }

    const payload = payloadFn(state);
    const timestamp = new Date().toISOString();

    const result = await callDelegatedService({
      discoveryRunId,
      buyerAgentName: macroNode,
      sellerServiceName: serviceName,
      payload,
      buyerWalletIdOverride: parentWalletId,
      paymentLayer: options?.paymentLayer,
      paymentSchemeOverride: options?.paymentSchemeOverride,
    });

    const evaluation: ServiceEvaluation = {
      serviceName,
      macroNode: macroNode as ServiceEvaluation["macroNode"],
      input: payload,
      output: result.data,
      safeSummary: result.safeSummary,
      status: result.ok ? "completed" : "failed",
      costUsdc: result.safeCallMeta.costUsdc,
      startedAt: timestamp,
      completedAt: new Date().toISOString(),
      error: result.error,
      settled: result.settled,
      mode: result.mode,
    };

    // Build payment edge if settled
    const edges: PaymentEdge[] = [];
    if (result.settled) {
      const realTxHash = result.paymentMeta?.txHash as string | null | undefined;
      edges.push({
        edgeId: randomUUID(),
        buyerServiceName: macroNode as ServiceEvaluation["macroNode"],
        sellerServiceName: serviceName,
        amountUsdc: result.safeCallMeta.costUsdc,
        status: "executed",
        paymentRef: null, // no real paymentId from GatewayWalletBatched
        settlementRef: realTxHash || null, // real txHash if available
      });
    }

    const summary = `${macroNode} → ${serviceName}: ${result.ok ? "completed" : "failed"} (${result.mode}, settled=${result.settled})`;

    return {
      serviceEvaluations: [evaluation],
      paymentEdges: edges,
      progressSummaries: [summary],
      _serviceResult: {
        serviceEvaluations: [evaluation],
        paymentEdges: edges,
        progressSummaries: [summary],
        budgetDelta: { serviceName, costUsdc: result.safeCallMeta.costUsdc, settled: result.settled },
        handlerData: result.data,
      },
    };
  };
}

/**
 * Selection guard — check if a service should run.
 */
export function isSelected(selectedServices: string[] | undefined, name: string): boolean {
  if (!selectedServices || selectedServices.length === 0) return true;
  return selectedServices.includes(name);
}
