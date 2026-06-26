/**
 * Agent Service Handlers — Barrel Export
 */

export { intentPlannerHandler } from "./intent-planner";
export { queryBuilderHandler } from "./query-builder";
export { signalScoutHandler } from "./signal-scout";
export { signalScoutBasicsHandler } from "./signal-scout-basics";
export { intentMatcherHandler } from "./intent-matcher";
export { sourceVerifierHandler } from "./source-verifier";
export { valueAllocatorHandler } from "./value-allocator";
export { trustVerifierHandler } from "./trust-verifier";
export { paymentDeciderHandler } from "./payment-decider";
export { paymentRouterHandler } from "./payment-router";
export { creatorAttributionHandler } from "./creator-attribution";
export { advancedEvidenceEvaluatorHandler } from "./advanced-evidence-evaluator";
export { creatorPayoutRouterHandler } from "./creator-payout-router";

import { intentPlannerHandler } from "./intent-planner";
import { queryBuilderHandler } from "./query-builder";
import { signalScoutHandler } from "./signal-scout";
import { signalScoutBasicsHandler } from "./signal-scout-basics";
import { intentMatcherHandler } from "./intent-matcher";
import { sourceVerifierHandler } from "./source-verifier";
import { valueAllocatorHandler } from "./value-allocator";
import { trustVerifierHandler } from "./trust-verifier";
import { paymentDeciderHandler } from "./payment-decider";
import { paymentRouterHandler } from "./payment-router";
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
  payment_router: paymentRouterHandler,
  creator_attribution: creatorAttributionHandler,
  advanced_evidence_evaluator: advancedEvidenceEvaluatorHandler,
  creator_payout_router: creatorPayoutRouterHandler,
};
