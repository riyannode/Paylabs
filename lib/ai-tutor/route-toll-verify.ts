/**
 * Route Toll Proof Verification
 *
 * Shared helper for propose endpoints to verify route toll proof
 * from server-side DB record, not just client headers.
 *
 * Called by /api/paylabs/learning-paths/propose and /api/paylabs/tutor/propose
 * when PAYLABS_ROUTE_TOLL_ENABLED=true.
 */

import { supabaseAdmin } from "@/lib/supabase/server";

export interface RouteTollProofHeaders {
  routePaymentId: string;
  routePaymentRef: string | null;
  routeSettlementRef: string | null;
  routeInputHash: string;
}

export interface RouteTollVerifyResult {
  ok: boolean;
  error?: string;
  status?: number; // HTTP status code to return
}

/**
 * Verify route toll proof against server-side DB record.
 *
 * Checks:
 * 1. Headers are present (paymentId, paymentRef||settlementRef, inputHash)
 * 2. DB record exists with matching payment_id
 * 3. DB record: input_hash matches
 * 4. DB record: user_wallet matches (lowercased)
 * 5. DB record: route_tier matches
 * 6. DB record: status = completed
 * 7. DB record: payment_ref or settlement_ref exists
 *
 * Returns { ok: true } if valid, or { ok: false, error, status } if invalid.
 */
export async function verifyRouteTollProof(
  headers: RouteTollProofHeaders,
  userWallet: string,
  routeTier: string,
  goal: string
): Promise<RouteTollVerifyResult> {
  const { routePaymentId, routePaymentRef, routeSettlementRef, routeInputHash } = headers;

  // Step 1: Header completeness
  if (!routePaymentId) {
    return {
      ok: false,
      error: "Route toll proof required: missing x-route-payment-id header. Pay route toll first via POST /api/paylabs/tutor/route-toll.",
      status: 402,
    };
  }
  if (!routePaymentRef && !routeSettlementRef) {
    return {
      ok: false,
      error: "Route toll proof required: missing x-route-payment-ref or x-route-settlement-ref header.",
      status: 402,
    };
  }
  if (!routeInputHash) {
    return {
      ok: false,
      error: "Route toll proof required: missing x-route-input-hash header.",
      status: 402,
    };
  }

  // Step 2-7: Verify against DB record
  const { data: tollRow, error: queryErr } = await supabaseAdmin()
    .from("paylabs_route_toll_calls")
    .select("id, user_wallet, route_tier, normalized_goal, input_hash, payment_ref, settlement_ref, status")
    .eq("payment_id", routePaymentId)
    .eq("status", "completed")
    .maybeSingle();

  if (queryErr) {
    return {
      ok: false,
      error: `Route toll verification failed: DB query error: ${queryErr.message}`,
      status: 500,
    };
  }

  if (!tollRow) {
    return {
      ok: false,
      error: "Route toll proof invalid: no completed record found for this payment_id.",
      status: 403,
    };
  }

  // Check input_hash match
  if (tollRow.input_hash !== routeInputHash) {
    return {
      ok: false,
      error: "Route toll proof invalid: input_hash mismatch.",
      status: 403,
    };
  }

  // Check user_wallet match
  if (tollRow.user_wallet !== userWallet.toLowerCase()) {
    return {
      ok: false,
      error: "Route toll proof invalid: wallet mismatch.",
      status: 403,
    };
  }

  // Check route_tier match
  if (tollRow.route_tier !== routeTier) {
    return {
      ok: false,
      error: "Route toll proof invalid: route_tier mismatch.",
      status: 403,
    };
  }

  // Check normalized_goal match
  if (tollRow.normalized_goal !== goal) {
    return {
      ok: false,
      error: "Route toll proof invalid: goal mismatch. Pay route toll again for the updated goal.",
      status: 403,
    };
  }

  // Check payment_ref or settlement_ref exists in DB record
  if (!tollRow.payment_ref && !tollRow.settlement_ref) {
    return {
      ok: false,
      error: "Route toll proof invalid: no payment_ref or settlement_ref in stored record.",
      status: 403,
    };
  }

  return { ok: true };
}
