/**
 * Gateway /v1/estimate
 *
 * Calls Gateway estimate API to get the canonical BurnIntent with
 * maxFee and maxBlockHeight filled by Gateway.
 *
 * Request shape: array of { spec: TransferSpec }
 * Response shape: { body: [{ burnIntent }], fees: { total, perIntent } }
 */

import { GATEWAY_TESTNET_URL } from "./gateway-types";
import type { GatewayEstimateResponse, TransferSpec, BurnIntent } from "./gateway-types";

export interface EstimateInput {
  spec: TransferSpec;
}

export interface EstimateResult {
  ok: boolean;
  burnIntent?: BurnIntent;
  transferSpecHash?: string;
  gatewayFee?: string;
  gatewayExpiration?: number;
  error?: string;
}

/**
 * Call Gateway POST /v1/estimate with a full TransferSpec.
 * Returns the canonical BurnIntent from Gateway (with fee + expiration filled).
 */
export async function estimateGatewayWithdrawal(
  input: EstimateInput,
): Promise<EstimateResult> {
  const gatewayUrl = process.env.PAYLABS_GATEWAY_API_URL || GATEWAY_TESTNET_URL;

  try {
    const resp = await fetch(`${gatewayUrl}/v1/estimate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ spec: input.spec }]),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "unknown");
      return {
        ok: false,
        error: `Gateway estimate failed: HTTP ${resp.status} — ${text.slice(0, 200)}`,
      };
    }

    const raw = (await resp.json()) as unknown;

    // Gateway API may return a root-level array OR { body: [...] }
    let burnIntent: BurnIntent | undefined;
    let transferSpecHash: string | undefined;

    if (Array.isArray(raw) && raw.length > 0) {
      // Root-level array: [{ burnIntent, ... }]
      const first = raw[0] as Record<string, unknown>;
      burnIntent = first?.burnIntent as BurnIntent | undefined;
      const fees = (raw as any).fees;
      transferSpecHash = fees?.perIntent?.[0]?.transferSpecHash ?? undefined;
    } else if (raw && typeof raw === "object" && "body" in raw) {
      // Legacy wrapped format: { body: [{ burnIntent }], fees: {...} }
      const data = raw as GatewayEstimateResponse;
      burnIntent = data.body?.[0]?.burnIntent;
      transferSpecHash = data.fees?.perIntent?.[0]?.transferSpecHash ?? undefined;
    }
    if (!burnIntent) {
      return { ok: false, error: "Gateway estimate returned no burnIntent" };
    }

    return {
      ok: true,
      burnIntent,
      transferSpecHash,
      gatewayFee: burnIntent.maxFee,
      gatewayExpiration: Number(burnIntent.maxBlockHeight),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Gateway estimate failed: ${msg}` };
  }
}
