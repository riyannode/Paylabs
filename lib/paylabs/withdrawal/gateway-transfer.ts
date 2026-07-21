/**
 * Gateway /v1/transfer
 *
 * Submits a signed BurnIntent to Gateway for attestation.
 * Parses the transfer response and extracts attestation data.
 * Provides recovery via GET /v1/transfer/{transferId}.
 */

import { hashTypedData, keccak256, toBytes, type Hex } from "viem";
import { GATEWAY_TESTNET_URL } from "./gateway-types";
import { GATEWAY_EIP712_DOMAIN, GATEWAY_EIP712_TYPES, type BurnIntent } from "./gateway-types";

// ─── Real EIP-712 Digest ─────────────────────────────────────

/**
 * Compute real EIP-712 typed-data hash for a BurnIntent.
 * Uses keccak256(0x1901 || domainSeparator || hashStruct(BurnIntent)).
 * This is the standard Ethereum EIP-712 encoding.
 */
export function computeBurnIntentDigest(burnIntent: BurnIntent): string {
  return hashTypedData({
    domain: GATEWAY_EIP712_DOMAIN as { name: string; version: string },
    types: GATEWAY_EIP712_TYPES as any,
    primaryType: "BurnIntent",
    message: burnIntent as any,
  });
}

/**
 * Real Ethereum keccak-256 hash of a hex string.
 * Used for attestation_hash.
 */
export function keccak256Hex(hex: string): string {
  const clean = hex.startsWith("0x") ? hex : `0x${hex}`;
  return keccak256(clean as Hex);
}

// ─── Gateway Transfer Submission ─────────────────────────────

export interface SubmitTransferInput {
  burnIntent: BurnIntent;
  signature: string;
}

export interface SubmitTransferResult {
  ok: boolean;
  /** Gateway transferId — REQUIRED on success. Empty string = protocol error. */
  transferId: string;
  attestation: string;
  operatorSignature: string;
  attestationHash: string;
  error?: string;
  ambiguous?: boolean;
}

/**
 * Submit signed BurnIntent to Gateway POST /v1/transfer.
 * transferId is REQUIRED per Circle docs. Missing = protocol error → reconciliation.
 */
export async function submitGatewayTransfer(
  input: SubmitTransferInput,
): Promise<SubmitTransferResult> {
  const gatewayUrl = process.env.PAYLABS_GATEWAY_API_URL || GATEWAY_TESTNET_URL;
  const emptyResult = { transferId: "", attestation: "", operatorSignature: "", attestationHash: "" };

  try {
    const resp = await fetch(`${gatewayUrl}/v1/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ burnIntent: input.burnIntent, signature: input.signature }]),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "unknown");
      return { ok: false, ...emptyResult, error: `Gateway transfer failed: HTTP ${resp.status} — ${text.slice(0, 300)}` };
    }

    const data = await resp.json() as Record<string, any>;

    if (!data.attestation || !data.signature) {
      return { ok: false, ...emptyResult, error: "Gateway transfer response missing attestation or signature" };
    }

    // transferId is REQUIRED
    if (!data.transferId) {
      return {
        ok: false,
        ...emptyResult,
        attestation: data.attestation,
        operatorSignature: data.signature,
        error: "Gateway transfer response missing transferId (protocol error)",
      };
    }

    return {
      ok: true,
      transferId: data.transferId,
      attestation: data.attestation,
      operatorSignature: data.signature,
      attestationHash: keccak256Hex(data.attestation),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("abort") || msg.includes("timeout") || msg.includes("fetch failed")) {
      return { ok: false, ...emptyResult, ambiguous: true, error: `Gateway transfer timed out: ${msg}` };
    }
    return { ok: false, ...emptyResult, error: `Gateway transfer failed: ${msg}` };
  }
}

// ─── Gateway Transfer Recovery ───────────────────────────────

export interface GatewayTransferStatus {
  status: string;
  attestationPayload: string | null;
  attestationSignature: string | null;
  expirationBlock: number | null;
  transactionHash: string | null;
}

/**
 * Retrieve Gateway transfer status via GET /v1/transfer/{transferId}.
 * Used for attestation recovery and reconciliation.
 */
export async function getGatewayTransferById(
  transferId: string,
): Promise<{ ok: boolean; data?: GatewayTransferStatus; error?: string }> {
  const gatewayUrl = process.env.PAYLABS_GATEWAY_API_URL || GATEWAY_TESTNET_URL;

  try {
    const resp = await fetch(`${gatewayUrl}/v1/transfer/${transferId}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "unknown");
      return { ok: false, error: `Gateway GET /v1/transfer failed: HTTP ${resp.status} — ${text.slice(0, 200)}` };
    }

    const data = await resp.json() as Record<string, any>;

    return {
      ok: true,
      data: {
        status: data.status || "UNKNOWN",
        attestationPayload: data.attestation?.payload || null,
        attestationSignature: data.attestation?.signature || null,
        expirationBlock: data.attestation?.expirationBlock ?? null,
        transactionHash: data.transactionHash || null,
      },
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Gateway transfer recovery failed: ${msg}` };
  }
}
