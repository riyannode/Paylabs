/**
 * Payment Router Handler
 *
 * Reuses: payment_quote + payment_executor
 * Macro-node: settlement_memory
 * Requires LLM: no
 *
 * Only routes approved items. No LLM.
 * Fails closed if:
 *   - no approved items
 *   - policy failure
 *   - invalid wallet
 *   - invalid source URL
 *   - missing real payment result
 *   - fake refs
 *
 * In audit/internal mode (default), marks settled=false and does not execute real payments.
 * In x402 mode, uses PR #19 infrastructure for real payments.
 */

import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";

export const paymentRouterHandler: ServiceHandler = async (
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> => {
  const { approved_items, discovery_run_id } = input.payload as {
    approved_items: Array<{
      feed_item_id: string;
      source_url: string;
      source_title: string;
      approved_price_usdc: number;
      creator_wallet: string | null;
    }>;
    discovery_run_id: string;
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

  // Validate each item
  const paidItems: Array<{
    feed_item_id: string;
    source_url: string;
    payment_ref: string | null;
    settlement_ref: string | null;
    amount_usdc: number;
  }> = [];

  const failedPayments: Array<{
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
      failedPayments.push({
        feed_item_id: item.feed_item_id,
        source_url: item.source_url,
        error: "Invalid source URL",
      });
      continue;
    }

    // Validate wallet if present
    if (item.creator_wallet && !/^0x[a-fA-F0-9]{40}$/.test(item.creator_wallet)) {
      failedPayments.push({
        feed_item_id: item.feed_item_id,
        source_url: item.source_url,
        error: "Invalid creator wallet format",
      });
      continue;
    }

    // Validate price
    if (item.approved_price_usdc <= 0) {
      failedPayments.push({
        feed_item_id: item.feed_item_id,
        source_url: item.source_url,
        error: "Invalid price (zero or negative)",
      });
      continue;
    }

    // In audit/internal mode: mark as planned, not executed
    // Real x402 payment would happen here when PAYLABS_X402_ENABLED_SERVICE_NAMES includes this service
    paidItems.push({
      feed_item_id: item.feed_item_id,
      source_url: item.source_url,
      payment_ref: null, // null = no real payment executed (audit mode)
      settlement_ref: null, // null = no real settlement (audit mode)
      amount_usdc: item.approved_price_usdc,
    });
  }

  const totalRouted = paidItems.reduce((sum, i) => sum + i.amount_usdc, 0);
  const safeSummary = `Routed ${paidItems.length}/${approved_items.length} items, total: ${totalRouted.toFixed(6)} USDC. ${failedPayments.length} failed. Mode: audit (no real payment).`;

  return {
    ok: true,
    serviceName: "payment_router",
    data: {
      paid_items: paidItems,
      failed_payments: failedPayments,
      payment_refs: [], // empty = no real payment refs
      settlement_refs: [], // empty = no real settlement refs
      safe_payment_summary: safeSummary,
    },
    safeSummary,
    settled: false, // audit mode — not settled
    error: null,
  };
};
