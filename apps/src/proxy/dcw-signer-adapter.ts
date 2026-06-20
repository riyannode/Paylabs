/**
 * DCW Signer Adapter for x402 Buyer Transport
 *
 * Bridges circleDcw.ts (DCW SDK wrapper) to the DcwSigner interface
 * expected by lib/paylabs/transports/circle-dcw-x402-buyer.ts.
 *
 * This file lives in apps/vercel-backend/ because it depends on
 * circleDcw.ts which wraps the DCW SDK. The buyer transport in lib/
 * receives this adapter via dependency injection — no backward imports.
 */

import {
  signTypedData as dcwSignTypedData,
  getWallet as dcwGetWallet,
  type SignTypedDataInput,
} from "../services/circleDcw.js";
import type { DcwSigner } from "../../../lib/paylabs/x402/buyer-transport.js";

/**
 * Create a DcwSigner adapter backed by Circle DCW SDK.
 *
 * Usage:
 *   const signer = createDcwSigner();
 *   const result = await callPaidSeller(signer, { ... });
 */
export function createDcwSigner(): DcwSigner {
  return {
    async signTypedData(input: SignTypedDataInput): Promise<string> {
      return dcwSignTypedData(input);
    },

    async getWalletAddress(walletId: string): Promise<string> {
      const wallet = await dcwGetWallet(walletId);
      if (!wallet?.address) {
        throw new Error(`DCW wallet ${walletId} not found or has no address`);
      }
      return wallet.address;
    },
  };
}
