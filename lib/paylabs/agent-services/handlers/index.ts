/**
 * Agent Service Handlers — Barrel Export
 */

import { intentPlannerHandler } from "./intent-planner";
import { queryBuilderHandler } from "./query-builder";
import { signalScoutHandler } from "./signal-scout";
import { signalScoutBasicsHandler } from "./signal-scout-basics";
import { intentMatcherHandler } from "./intent-matcher";
import { sourceVerifierHandler } from "./source-verifier";
import { valueAllocatorHandler } from "./value-allocator";
import { trustVerifierHandler } from "./trust-verifier";
import { paymentDeciderHandler } from "./payment-decider";
import { creatorAttributionHandler } from "./creator-attribution";
import { advancedEvidenceEvaluatorHandler } from "./advanced-evidence-evaluator";
import { creatorPayoutRouterHandler } from "./creator-payout-router";
import type { ServiceName, ServiceHandler } from "../types";

/**
 * Map of service name to handler function.
 */
export const SERVICE_HANDLERS: Record<ServiceName, ServiceHandler> = {
  intent_planner: intentPlannerHandler,
  query_builder: queryBuilderHandler,
  signal_scout: signalScoutHandler,
  signal_scout_basics: signalScoutBasicsHandler,
  intent_matcher: intentMatcherHandler,
  source_verifier: sourceVerifierHandler,
  value_allocator: valueAllocatorHandler,
  trust_verifier: trustVerifierHandler,
  payment_decider: paymentDeciderHandler,
  creator_attribution: creatorAttributionHandler,
  advanced_evidence_evaluator: advancedEvidenceEvaluatorHandler,
  creator_payout_router: creatorPayoutRouterHandler,
};
