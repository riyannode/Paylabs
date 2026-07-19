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
import { isX402EnabledForService } from "../../feature-flags";
import { randomUUID } from "node:crypto";
import { phaseFromMacroNode, isOfficeServiceName } from "../../office/event-mapper";
import { safeEmitOfficeEvent } from "../../office/server";

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
    /** If true, fail closed when x402 is not enabled for this service (default: true for macro_to_child). */
    required?: boolean;
    /** If true, skip service when not in selectedServices list (default: false for macro graph children). */
    skipIfNotSelected?: boolean;
  }
): (state: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async (state: Record<string, unknown>) => {
    // Cast state properties (LangGraph passes full state as Record<string, unknown>)
    const discoveryRunId = state.discoveryRunId as string;
    const parentWalletId = state.parentWalletId as string | undefined;
    const selectedServices = state.selectedServices as string[] | undefined;

    // Check if this service is in the selected services list
    // Only skip when skipIfNotSelected === true (default: false for macro graph children)
    const shouldApplySelectionGuard = options?.skipIfNotSelected === true;
    console.log("[service-node-selection]", JSON.stringify({
      discoveryRunId,
      macroNode,
      serviceName,
      selectedServices: selectedServices || [],
      skipIfNotSelected: options?.skipIfNotSelected === true,
      willSkip: Boolean(
        options?.skipIfNotSelected === true &&
        selectedServices &&
        selectedServices.length > 0 &&
        !selectedServices.includes(serviceName)
      ),
    }));
    if (shouldApplySelectionGuard && selectedServices && selectedServices.length > 0 && !selectedServices.includes(serviceName)) {
      const summary = `${macroNode} → ${serviceName}: skipped (not in execution plan)`;
      const skippedEval: ServiceEvaluation = {
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
      };
      return {
        serviceEvaluations: [skippedEval],
        paymentEdges: [],
        progressSummaries: [summary],
        _serviceResult: {
          serviceEvaluations: [skippedEval],
          paymentEdges: [],
          progressSummaries: [summary],
          budgetDelta: { serviceName, costUsdc: 0, settled: false },
          handlerData: null,
        },
      };
    }

    const payload = payloadFn(state);
    const timestamp = new Date().toISOString();

    // Safe diagnostic for x402 child validation (no secrets)
    const isRequired = options?.required !== false && options?.paymentLayer === "macro_to_child";
    const skipIfNotSel = options?.skipIfNotSelected === true;
    const x402EnabledForService = isX402EnabledForService(serviceName);
    console.log(`[x402-child-required] ${JSON.stringify({
      discoveryRunId,
      macroNode,
      serviceName,
      paymentLayer: options?.paymentLayer ?? null,
      paymentMode: options?.paymentSchemeOverride ?? null,
      required: isRequired,
      skipIfNotSelected: skipIfNotSel,
      x402Enabled: x402EnabledForService,
      hasParentWalletId: !!parentWalletId,
    })}`);

    // Fail closed: required macro_to_child service must have x402 enabled
    // Do NOT silently downgrade to audit_only
    if (isRequired && !x402EnabledForService) {
      const summary = `${macroNode} → ${serviceName}: FAILED (required x402 child not enabled)`;
      const failedEval: ServiceEvaluation = {
        serviceName,
        macroNode: macroNode as ServiceEvaluation["macroNode"],
        input: {},
        output: null,
        safeSummary: summary,
        status: "failed",
        costUsdc: 0,
        startedAt: null,
        completedAt: null,
        error: "required x402 child not enabled in PAYLABS_X402_ENABLED_SERVICE_NAMES",
        settled: false,
        mode: "x402",
      };
      if (isOfficeServiceName(serviceName)) {
        await safeEmitOfficeEvent({
          runId: discoveryRunId,
          type: "agent.failed",
          phase: phaseFromMacroNode(macroNode),
          status: "failed",
          agentId: serviceName,
          title: `${serviceName} failed`,
          message: "Required x402 child is not enabled",
          metadata: { reason: "required_x402_child_not_enabled" },
        });
      }
      return {
        serviceEvaluations: [failedEval],
        paymentEdges: [],
        progressSummaries: [summary],
        _serviceResult: {
          serviceEvaluations: [failedEval],
          paymentEdges: [],
          progressSummaries: [summary],
          budgetDelta: { serviceName, costUsdc: 0, settled: false },
          handlerData: null,
        },
      };
    }

    // NOTE: agent.started and x402.settled events are now emitted by the
    // seller endpoint (agent-services/[serviceName]/run/route.ts) to ensure
    // correct visual ordering: x402.requested → Gateway, x402.settled → Gateway,
    // agent.started → desk. The service-node only emits the final completion event.

    const result = await callDelegatedService({
      discoveryRunId,
      buyerAgentName: macroNode,
      sellerServiceName: serviceName,
      payload,
      buyerWalletIdOverride: parentWalletId,
      paymentLayer: options?.paymentLayer,
      paymentSchemeOverride: options?.paymentSchemeOverride,
    });

    // NOTE: x402.settled is now emitted by the seller endpoint (route.ts)
    // before the handler executes — see comment above.

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
      paymentMeta: result.paymentMeta == null ? undefined : result.paymentMeta,
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
        layer: options?.paymentLayer ?? "macro_to_child",
        accountingRole: "macro_internal_child_spend",
        sourceOfFunds: "macro_allocation",
        paymentMode: options?.paymentSchemeOverride ?? "circle_gateway_wallet_batched_per_child_fallback",
        paymentRef: null,
        settlementRef: realTxHash || null,
        txHash: realTxHash ?? null,
        explorerUrl: result.paymentMeta?.explorerUrl as string | null ?? null,
      });
    }

    const summary = `${macroNode} → ${serviceName}: ${result.ok ? "completed" : "failed"} (${result.mode}, settled=${result.settled})`;

    if (isOfficeServiceName(serviceName)) {
      const output = (result.data ?? {}) as Record<string, unknown>;
      const isCreatorPayoutRouter = serviceName === "creator_payout_router";
      const creatorPayoutResults = isCreatorPayoutRouter
        ? ((output.creator_payout_results as Array<Record<string, unknown>> | undefined) ?? [])
        : [];
      const paidCreatorResults = creatorPayoutResults.filter(
        (row) => row.status === "paid" || row.status === "gateway_accepted",
      );
      const splitPlan = isCreatorPayoutRouter ? (output.split_plan as Record<string, unknown> | undefined) : undefined;
      const pendingReserveAtomicRaw = splitPlan?.pending_creator_reserve_atomic ?? output.pending_creator_reserve_atomic;
      const pendingReserveAtomic = pendingReserveAtomicRaw == null ? null : String(pendingReserveAtomicRaw);
      const pendingReserveUsdcRaw = output.pending_creator_reserve;
      const pendingReserveUsdc = typeof pendingReserveUsdcRaw === "number"
        ? pendingReserveUsdcRaw
        : pendingReserveUsdcRaw == null
          ? null
          : Number(pendingReserveUsdcRaw);
      const hasPendingReserve = pendingReserveAtomic ? (() => {
        try {
          return BigInt(pendingReserveAtomic) > BigInt(0);
        } catch {
          return (pendingReserveUsdc ?? 0) > 0;
        }
      })() : (pendingReserveUsdc ?? 0) > 0;

      const officeEvent = result.ok && isCreatorPayoutRouter
        ? paidCreatorResults.length > 0
          ? {
              type: "creator.paid" as const,
              title: `${serviceName} creator payout completed`,
              message: `${paidCreatorResults.length} creator payout(s) completed`,
              metadata: {
                settled: result.settled,
                mode: result.mode,
                costUsdc: result.safeCallMeta.costUsdc,
                creatorPaidCount: paidCreatorResults.length,
                pendingReserveAtomic,
                pendingReserveUsdc,
              },
            }
          : {
              type: "treasury.retained" as const,
              title: `${serviceName} treasury reserve retained`,
              message: hasPendingReserve
                ? `${pendingReserveUsdc ?? 0} USDC retained in treasury reserve`
                : "No verified creator payout; funds retained in treasury reserve",
              metadata: {
                settled: result.settled,
                mode: result.mode,
                costUsdc: result.safeCallMeta.costUsdc,
                treasuryRetained: true,
                pendingReserveAtomic,
                pendingReserveUsdc,
                retentionReason: "no_verified_or_eligible_creator_or_unallocated_reserve",
              },
            }
        : {
            type: result.ok ? "agent.completed" as const : "agent.failed" as const,
            title: `${serviceName} ${result.ok ? "completed" : "failed"}`,
            message: result.safeSummary,
            metadata: {
              settled: result.settled,
              mode: result.mode,
              costUsdc: result.safeCallMeta.costUsdc,
            },
          };

      await safeEmitOfficeEvent({
        runId: discoveryRunId,
        phase: phaseFromMacroNode(macroNode),
        status: result.ok ? "completed" : "failed",
        agentId: serviceName,
        ...officeEvent,
      });
    }

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
