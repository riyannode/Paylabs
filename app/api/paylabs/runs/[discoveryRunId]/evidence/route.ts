/**
 * GET /api/paylabs/runs/[discoveryRunId]/evidence
 *
 * Returns the Deep Agent evaluator trace for a specific run.
 * Shows: tool calls, evidence matrix, scores, rationale, memory.
 *
 * Only available for Advanced tier runs that used the evaluator.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ discoveryRunId: string }> }
) {
  try {
    const { discoveryRunId } = await params;

    if (!discoveryRunId) {
      return NextResponse.json(
        { ok: false, error: "discoveryRunId required" },
        { status: 400 }
      );
    }

    const db = supabaseAdmin();

    // 1. Get receipt for this run
    const { data: receipt } = await db
      .from("paylabs_receipts")
      .select("*")
      .eq("discovery_run_id", discoveryRunId)
      .single();

    // 2. Get evaluator memory for this run
    const { data: evaluatorMemory } = await db
      .from("paylabs_evaluator_memory")
      .select("*")
      .eq("discovery_run_id", discoveryRunId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    // 3. Get creator payout events for this run
    const { data: payoutEvents } = await db
      .from("paylabs_creator_payout_events")
      .select("*")
      .eq("discovery_run_id", discoveryRunId)
      .order("created_at", { ascending: true });

    // 4. Get source attributions for this run
    const { data: attributions } = await db
      .from("paylabs_source_attributions")
      .select("*")
      .eq("discovery_run_id", discoveryRunId)
      .order("created_at", { ascending: true });

    // 5. Get service payment events (includes evaluator service call)
    const { data: serviceEvents } = await db
      .from("paylabs_service_payment_events")
      .select("*")
      .eq("discovery_run_id", discoveryRunId)
      .order("created_at", { ascending: true });

    // 6. Get run events for full timeline
    const { data: runEvents } = await db
      .from("paylabs_run_events")
      .select("*")
      .eq("discovery_run_id", discoveryRunId)
      .order("sequence", { ascending: true });

    // Build evidence response
    const evidence = {
      ok: true,
      discovery_run_id: discoveryRunId,
      route_tier: receipt?.selected_tier || "unknown",
      advanced_evaluator_used: receipt?.advanced_evaluator_used || false,

      // Evaluator output
      evaluator: evaluatorMemory
        ? {
            safe_summary: evaluatorMemory.safe_evaluator_summary,
            why_two_sources_needed: evaluatorMemory.why_two_sources_needed,
            confidence: evaluatorMemory.evaluator_confidence,
            warnings: evaluatorMemory.warnings,
            source_ids: evaluatorMemory.source_ids,
            source_urls: evaluatorMemory.source_urls,
          }
        : null,

      // Creator attributions
      attributions: (attributions || []).map((a: Record<string, unknown>) => ({
        feed_item_id: a.feed_item_id,
        source_url: a.source_url,
        source_title: a.source_title,
        publisher: a.publisher,
        creator_wallet: a.creator_wallet,
        claim_status: a.claim_status,
        eligibility_status: a.eligibility_status,
        final_score: a.final_score,
        risk_score: a.risk_score,
        reason: a.attribution_reason,
      })),

      // Payout results
      payouts: (payoutEvents || []).map((p: Record<string, unknown>) => ({
        feed_item_id: p.feed_item_id,
        source_url: p.source_url,
        source_title: p.source_title,
        creator_wallet: p.creator_wallet,
        status: p.status,
        planned_amount_usdc: p.planned_amount_usdc,
        actual_amount_usdc: p.actual_amount_usdc,
        settlement_id: p.settlement_id,
        tx_hash: p.tx_hash,
        explorer_url: p.explorer_url,
        safe_summary: p.safe_summary,
      })),

      // Receipt summary
      receipt: receipt
        ? {
            execution_fee_usdc: receipt.execution_fee_usdc,
            planned_creator_pool_usdc: receipt.planned_creator_pool_usdc,
            actual_creator_paid_usdc: receipt.actual_creator_paid_usdc,
            planned_creator_payout_count: receipt.planned_creator_payout_count,
            actual_creator_payout_count: receipt.actual_creator_payout_count,
            pending_creator_reserve_usdc: receipt.pending_creator_reserve_usdc,
            bot_share_usdc: receipt.bot_share_usdc,
            service_share_usdc: receipt.service_share_usdc,
            creator_split_policy: receipt.creator_split_policy,
            advanced_evaluator_confidence:
              receipt.advanced_evaluator_confidence,
            advanced_evaluator_rationale:
              receipt.advanced_evaluator_rationale,
            why_two_sources_needed: receipt.why_two_sources_needed,
            safe_receipt_summary: receipt.safe_receipt_summary,
          }
        : null,

      // Service call timeline (tool calls visible here)
      service_timeline: (serviceEvents || []).map((e: Record<string, unknown>) => ({
        service: e.seller,
        status: e.status,
        amount_usdc: e.amount_usdc,
        safe_summary: e.safe_summary,
        created_at: e.created_at,
      })),

      // Full run timeline
      timeline: (runEvents || []).map((e: Record<string, unknown>) => ({
        event_type: e.event_type,
        actor: e.actor_name,
        target: e.target_name,
        status: e.status,
        safe_summary: e.safe_summary,
        sequence: e.sequence,
        created_at: e.created_at,
      })),
    };

    return NextResponse.json(evidence);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
