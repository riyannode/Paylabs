/**
 * Gateway BurnIntent Signer (DCW)
 *
 * Dedicated signer for Gateway BurnIntent EIP-712 typed data.
 * Uses 2-field domain (name + version) — NOT the 4-field domain
 * used by the x402 adapter (name + version + chainId + verifyingContract).
 *
 * This signer is SEPARATE from the x402 DcwSigner to avoid breaking
 * existing x402 payment signing behavior.
 */

import { createRequire } from "node:module";
import type { BurnIntent } from "./gateway-types";
import { GATEWAY_EIP712_DOMAIN, GATEWAY_EIP712_TYPES } from "./gateway-types";

// CJS interop — @circle-fin/developer-controlled-wallets is CJS
const _require = createRequire(import.meta.url);

// ─── Lazy DCW Client ─────────────────────────────────────────

let _dcwClient: any = null;

function getDcwClient() {
  if (_dcwClient) return _dcwClient;
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) {
    throw new Error("CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET required for Gateway BurnIntent signing");
  }
  const mod = _require("@circle-fin/developer-controlled-wallets");
  _dcwClient = mod.initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  return _dcwClient;
}

// ─── Bigint Serializer ───────────────────────────────────────

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

// ─── Gateway BurnIntent Signing ──────────────────────────────

/**
 * Sign a canonical BurnIntent using the Gateway-specific EIP-712 domain.
 *
 * The domain contains ONLY name + version — NOT chainId or verifyingContract.
 * This is critical for Gateway attestation validity.
 *
 * @param walletId - The DCW wallet ID to sign with
 * @param burnIntent - The exact canonical BurnIntent from Gateway /v1/estimate
 * @returns hex signature string
 */
export async function signGatewayBurnIntent(
  walletId: string,
  burnIntent: BurnIntent,
): Promise<string> {
  const client = getDcwClient();

  // Build EIP-712 typed data with Gateway-specific 2-field domain
  const typedData = {
    types: GATEWAY_EIP712_TYPES,
    domain: GATEWAY_EIP712_DOMAIN,
    primaryType: "BurnIntent",
    message: burnIntent,
  };

  const dataString = JSON.stringify(typedData, bigintReplacer);

  const response = await client.signTypedData({
    walletId,
    data: dataString,
  });

  const signature = response?.data?.signature;
  if (!signature) {
    throw new Error("DCW signTypedData returned no signature for Gateway BurnIntent");
  }

  return signature;
}
