/**
 * DCW Signer Adapter — App Layer
 *
 * Bridges the lib/ DcwSigner interface to the actual Circle DCW SDK.
 * Lives in the app layer because it imports from @circle-fin/developer-controlled-wallets.
 *
 * This adapter is injected once at startup via setDcwSigner().
 * The lib/ layer never imports from here — it uses the DcwSigner interface.
 *
 * Flow:
 *   1. Initialize DCW client with CIRCLE_API_KEY + ENTITY_SECRET
 *   2. signTypedData: calls DCW SDK → returns 0x hex signature
 *   3. getWalletAddress: resolves wallet ID → returns 0x address
 */

import { createRequire } from "node:module";
import type { DcwSigner } from "@/lib/paylabs/x402/buyer-transport";

// CJS interop — @circle-fin/developer-controlled-wallets is CJS
const _require = createRequire(import.meta.url);

// ─── Lazy SDK import ──────────────────────────────────────────

let _dcwClient: any = null;

function getDcwClient() {
  if (_dcwClient) return _dcwClient;

  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

  if (!apiKey || !entitySecret) {
    throw new Error(
      "CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET required for DCW signer"
    );
  }

  try {
    const mod = _require("@circle-fin/developer-controlled-wallets");
    const initFn = mod.initiateDeveloperControlledWalletsClient;
    if (!initFn) {
      throw new Error("initiateDeveloperControlledWalletsClient not found in SDK");
    }
    _dcwClient = initFn({ apiKey, entitySecret });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to initialize DCW client: ${msg}`);
  }

  return _dcwClient;
}

// ─── Signer Adapter ───────────────────────────────────────────

/**
 * Create a DcwSigner backed by the Circle DCW SDK.
 *
 * This is the production signer — it calls Circle API to sign
 * EIP-712 typed data. The private key never leaves Circle's HSM.
 */
export function createDcwSigner(): DcwSigner {
  return {
    async signTypedData(input) {
      const client = getDcwClient();

      // Circle DCW API expects EIP-712 typed data as a JSON string.
      // Per Circle docs, EIP712Domain MUST be in types, and uint256
      // values must be decimal strings (not hex).
      const typesWithDomain: Record<string, unknown> = {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        ...input.types,
      };
      const dataString = JSON.stringify(
        {
          types: typesWithDomain,
          primaryType: input.primaryType,
          domain: input.domain,
          message: input.message,
        },
        (_key, value) => (typeof value === "bigint" ? value.toString() : value)
      );

      let response: any; // eslint-disable-line @typescript-eslint/no-explicit-any
      try {
        response = await client.signTypedData({
          walletId: input.walletId,
          data: dataString,
        });
      } catch (e: unknown) {
        // Log full DCW API error for debugging (no secrets)
        const errDetail = e instanceof Error ? e.message : String(e);
        const axiosResp = (e as any)?.response; // eslint-disable-line
        const respData = axiosResp?.data;
        console.error("[dcw-signer] signTypedData FAILED:", {
          error: errDetail,
          responseData: respData ? JSON.stringify(respData).slice(0, 500) : "none",
          dataLength: dataString.length,
          primaryType: input.primaryType,
          messageKeys: Object.keys(input.message || {}),
          typesKeys: Object.keys(input.types || {}),
        });
        throw e;
      }

      const signature = response?.data?.signature;
      if (!signature) {
        throw new Error("DCW signTypedData returned no signature");
      }

      return signature;
    },

    async getWalletAddress(walletId: string) {
      const client = getDcwClient();
      const response = await client.getWallet({ id: walletId });
      const address = response?.data?.wallet?.address;
      if (!address) {
        throw new Error(`DCW wallet not found: ${walletId}`);
      }
      return address;
    },
  };
}
