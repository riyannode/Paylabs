/**
 * Creator Distribution Payment Transport
 *
 * Server-side transport for creator/bot/service payouts.
 * Uses existing DCW signer + buyer-transport for real x402/Gateway payments.
 *
 * Rules:
 * - No local private keys
 * - No raw secrets in logs
 * - Transport is constructed server-side only
 * - Never passed via JSON payload
 */

import { getDcwSigner } from "@/lib/paylabs/x402/dcw-signer-adapter";
import { callPaidSeller } from "@/lib/paylabs/x402/buyer-transport";
import { resolvePaylabsAppUrl } from "@/lib/paylabs/runtime/resolve-app-url";
import type {
  CreatorPaymentTransport,
  CreatorPaymentTransportResult,
} from "./payout-executor";

function atomicToUsdcString(amountAtomic: string): string {
  const n = Number(amountAtomic);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("invalid_amount_atomic");
  }
  return (n / 1_000_000).toFixed(6);
}

function resolveCreatorPayoutBuyerWalletId(): string {
  const walletId = (
    process.env.PAYLABS_CREATOR_PAYOUT_BUYER_WALLET_ID ||
    process.env.PAYLABS_SETTLEMENT_TREASURY_WALLET_ID ||
    ""
  ).trim();

  if (!walletId) {
    throw new Error(
      "config_error: PAYLABS_CREATOR_PAYOUT_BUYER_WALLET_ID or PAYLABS_SETTLEMENT_TREASURY_WALLET_ID must be set",
    );
  }

  return walletId;
}

function resolveCreatorPayoutEndpoint(): string {
  const { baseUrl } = resolvePaylabsAppUrl();
  return `${baseUrl.replace(/\/+$/, "")}/api/paylabs/creator-distribution/payout`;
}

export function createCreatorPaymentTransport(): CreatorPaymentTransport {
  const dcwSigner = getDcwSigner();
  if (!dcwSigner) {
    throw new Error("config_error: DCW signer not initialized for creator payout transport");
  }

  const buyerWalletId = resolveCreatorPayoutBuyerWalletId();
  const sellerUrl = resolveCreatorPayoutEndpoint();

  return {
    async transfer(params: {
      toAddress: string;
      amountAtomic: string;
      metadata: Record<string, string>;
    }): Promise<CreatorPaymentTransportResult> {
      const toAddress = params.toAddress.trim().toLowerCase();

      if (!/^0x[a-fA-F0-9]{40}$/.test(toAddress)) {
        return {
          ok: false,
          status: "failed",
          error: "invalid_payout_destination",
        };
      }

      const maxAmountUsdc = atomicToUsdcString(params.amountAtomic);

      const result = await callPaidSeller(dcwSigner, {
        sellerUrl,
        method: "POST",
        body: {
          pay_to: toAddress,
          amount_atomic: params.amountAtomic,
          payout_metadata: params.metadata,
        },
        buyerWalletId,
        buyerAgentName: "paylabs_settlement_treasury",
        sellerServiceName: "creator_payout_router",
        discoveryRunId: params.metadata.discovery_run_id,
        maxAmountUsdc,
        requirePayment: true,
      });

      if (!result.ok || !result.paymentMetadata) {
        return {
          ok: false,
          status: "failed",
          error: result.error || "creator_payout_x402_failed",
        };
      }

      return {
        ok: true,
        status: result.paymentMetadata.gatewayAccepted ? "gateway_accepted" : "paid",
        settlementId: result.paymentMetadata.settlementId ?? null,
        settlementUrl: result.paymentMetadata.settlementUrl ?? null,
        txHash: result.paymentMetadata.txHash ?? null,
        explorerUrl: result.paymentMetadata.explorerUrl ?? null,
        batchTxHash: result.paymentMetadata.batchTxHash ?? null,
        batchExplorerUrl: result.paymentMetadata.batchExplorerUrl ?? null,
        error: null,
      };
    },
  };
}
