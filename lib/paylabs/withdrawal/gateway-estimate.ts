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

const BURN_INTENT_BYTES32_ADDRESS_FIELDS = [
  "sourceContract",
  "destinationContract",
  "sourceToken",
  "destinationToken",
  "sourceDepositor",
  "destinationRecipient",
  "sourceSigner",
  "destinationCaller",
] as const;

/**
 * Normalize BurnIntent address-like bytes32 fields returned by Gateway.
 * Gateway may return 20-byte EVM addresses for bytes32 EIP-712 fields;
 * those must be left-padded to 32 bytes before hashing/signing.
 */
function normalizeBurnIntentAddresses(burnIntent: BurnIntent): BurnIntent {
  const normalizeBytes32AddressField = (field: string, value: string): string => {
    const normalized = value.toLowerCase();

    if (/^0x[0-9a-f]{40}$/.test(normalized)) {
      return `0x${normalized.slice(2).padStart(64, "0")}`;
    }

    if (/^0x[0-9a-f]{64}$/.test(normalized)) {
      return normalized;
    }

    throw new Error(
      `Gateway estimate returned invalid BurnIntent ${field}: expected 20-byte address or bytes32 hex`,
    );
  };

  const spec = { ...burnIntent.spec };
  for (const field of BURN_INTENT_BYTES32_ADDRESS_FIELDS) {
    spec[field] = normalizeBytes32AddressField(field, spec[field]);
  }

  return { ...burnIntent, spec };
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

    // Gateway may return 20-byte addresses, but EIP-712 bytes32 fields require
    // 32-byte padded hex. Normalize all address-like BurnIntent spec fields
    // before any caller hashes, persists, or signs the BurnIntent.
    const normalizedBurnIntent = normalizeBurnIntentAddresses(burnIntent);

    return {
      ok: true,
      burnIntent: normalizedBurnIntent,
      transferSpecHash,
      gatewayFee: normalizedBurnIntent.maxFee,
      gatewayExpiration: Number(normalizedBurnIntent.maxBlockHeight),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Gateway estimate failed: ${msg}` };
  }
}
