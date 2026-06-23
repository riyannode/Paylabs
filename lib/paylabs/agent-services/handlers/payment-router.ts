/**
 * Payment Router Handler
 *
 * Macro-node: settlement_memory
 * Requires LLM: no
 *
 * Only routes approved items. No LLM.
 * This handler is ALWAYS routing-only in this PR.
 * x402 real payment routing is NOT implemented.
 *
 * Fails closed if:
 *   - no approved items
 *   - invalid wallet
 *   - invalid source URL
 *   - price <= 0
 *
 * Output uses routed_items (not paid_items) to avoid implying
 * that real payment has occurred. Status is always "planned".
 * settled is always false. mode is always "routing_only".
 *
 * No fake payment_ref, settlement_ref, tx_hash, or batch_id.
 */

import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";

export const paymentRouterHandler: ServiceHandler = async (
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> => {
  const { approved_items } = input.payload as {
    approved_items: Array<{
      feed_item_id: string;
      source_url: string;
      source_title: string;
      approved_price_usdc: number;
      creator_wallet: string | null;
    }>;
  };

  // Fail closed: no approved items
  if (!approved_items || approved_items.length === 0) {
    return {
      ok: false,
      serviceName: "payment_router",
      data: null,
      safeSummary: "No approved items to route. Payment router requires at least one approved item.",
      settled: false,
      error: "No approved items to route",
    };
  }

  // Validate and route each item
  const routedItems: Array<{
    feed_item_id: string;
    source_url: string;
    amount_usdc: number;
    status: "planned";
  }> = [];

  const failedItems: Array<{
    feed_item_id: string;
    source_url: string;
    error: string;
  }> = [];

  for (const item of approved_items) {
    // Validate source URL
    let validUrl = false;
    try {
      const url = new URL(item.source_url);
      validUrl = url.protocol === "https:" || url.protocol === "http:";
    } catch {
      // invalid URL
    }

    if (!validUrl) {
      failedItems.push({
        feed_item_id: item.feed_item_id,
        source_url: item.source_url,
        error: "Invalid source URL",
      });
      continue;
    }

    // Validate wallet if present
    if (item.creator_wallet && !/^0x[a-fA-F0-9]{40}$/.test(item.creator_wallet)) {
      failedItems.push({
        feed_item_id: item.feed_item_id,
        source_url: item.source_url,
        error: "Invalid creator wallet format",
      });
      continue;
    }

    // Validate price
    if (item.approved_price_usdc <= 0) {
      failedItems.push({
        feed_item_id: item.feed_item_id,
        source_url: item.source_url,
        error: "Invalid price (zero or negative)",
      });
      continue;
    }

    // Valid item — mark as planned (audit-only, not executed)
    routedItems.push({
      feed_item_id: item.feed_item_id,
      source_url: item.source_url,
      amount_usdc: item.approved_price_usdc,
      status: "planned",
    });
  }

  const totalPlanned = routedItems.reduce((sum, i) => sum + i.amount_usdc, 0);
  const safeSummary = `Routing-only: ${routedItems.length}/${approved_items.length} items validated and planned, total: ${totalPlanned.toFixed(6)} USDC. ${failedItems.length} failed validation. No real payment executed — payment_plan_ready only.`;

  return {
    ok: true,
    serviceName: "payment_router",
    data: {
      routed_items: routedItems,
      failed_items: failedItems,
      mode: "routing_only",
      settled: false,
      safe_payment_summary: safeSummary,
    },
    safeSummary,
    settled: false, // always false — creator/source payout not implemented
    error: null,
  };
};
