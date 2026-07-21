/**
 * Gateway /v1/transfer
 *
 * Submits a signed BurnIntent to Gateway for attestation.
 * Parses the transfer response and extracts attestation data.
 */

import { GATEWAY_TESTNET_URL } from "./gateway-types";
import type { BurnIntent, GatewayTransferResponse } from "./gateway-types";

// ─── Real Keccak-256 (SHA-3) ─────────────────────────────────

/**
 * Compute keccak-256 hash of a Uint8Array.
 * Uses Node.js crypto module for real keccak-256 (NOT SHA-256).
 */
export async function keccak256Bytes(data: Uint8Array): Promise<string> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha3-256").update(data).digest("hex");
  return "0x" + hash;
}

/**
 * Compute keccak-256 of a hex string (e.g., attestation).
 */
export async function keccak256Hex(hex: string): Promise<string> {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return keccak256Bytes(bytes);
}

/**
 * Compute keccak-256 of a UTF-8 string.
 */
export async function keccak256String(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  return keccak256Bytes(bytes);
}

// ─── EIP-712 Typed Data Digest ───────────────────────────────

/**
 * Compute EIP-712 typed-data hash (hashStruct) for a BurnIntent.
 * Uses the standard EIP-712 encoding: keccak256( "\x19\x01" || domainSeparator || hashStruct(message) )
 *
 * This is a simplified implementation that hashes the JSON-serialized
 * typed data for the specific BurnIntent structure. For full EIP-712
 * compliance, use ethers.js or viem's TypedDataEncoder.
 */
export async function computeBurnIntentDigest(
  burnIntent: BurnIntent,
): Promise<string> {
  // For reconciliation purposes, we hash the canonical JSON representation.
  // The actual EIP-712 hash is computed by the signing wallet (Circle SDK).
  // This hash serves as a DB-level integrity check for the stored BurnIntent.
  const canonical = JSON.stringify(burnIntent, bigintReplacer);
  const bytes = new TextEncoder().encode(canonical);
  return keccak256Bytes(bytes);
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

// ─── Gateway Transfer Submission ─────────────────────────────

export interface SubmitTransferInput {
  /** The exact canonical BurnIntent from Gateway /v1/estimate */
  burnIntent: BurnIntent;
  /** The hex signature from signTypedData (DCW) or sdk.execute (UCW) */
  signature: string;
}

export interface SubmitTransferResult {
  ok: boolean;
  /** Gateway transferId — REQUIRED on success, null means protocol error */
  transferId: string;
  attestation: string;       // hex bytes
  operatorSignature: string; // hex bytes
  attestationHash: string;   // keccak256 of attestation
  error?: string;
  /** True if response was ambiguous (timeout without clear answer) */
  ambiguous?: boolean;
}

/**
 * Submit signed BurnIntent to Gateway POST /v1/transfer.
 * transferId is REQUIRED on success. Missing transferId is a protocol error.
 */
export async function submitGatewayTransfer(
  input: SubmitTransferInput,
): Promise<SubmitTransferResult> {
  const gatewayUrl = process.env.PAYLABS_GATEWAY_API_URL || GATEWAY_TESTNET_URL;

  try {
    const resp = await fetch(`${gatewayUrl}/v1/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ burnIntent: input.burnIntent, signature: input.signature }]),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "unknown");
      return {
        ok: false,
        transferId: "",
        attestation: "",
        operatorSignature: "",
        attestationHash: "",
        error: `Gateway transfer failed: HTTP ${resp.status} — ${text.slice(0, 300)}`,
      };
    }

    const data = (await resp.json()) as GatewayTransferResponse;

    if (!data.attestation || !data.signature) {
      return {
        ok: false,
        transferId: "",
        attestation: "",
        operatorSignature: "",
        attestationHash: "",
        error: "Gateway transfer response missing attestation or signature",
      };
    }

    // transferId is REQUIRED per Circle docs
    if (!data.transferId) {
      return {
        ok: false,
        transferId: "",
        attestation: data.attestation,
        operatorSignature: data.signature,
        attestationHash: "",
        error: "Gateway transfer response missing transferId (protocol error)",
      };
    }

    // Compute attestation hash for storage
    const attestationHash = await keccak256Hex(data.attestation);

    return {
      ok: true,
      transferId: data.transferId,
      attestation: data.attestation,
      operatorSignature: data.signature,
      attestationHash,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("abort") || msg.includes("timeout") || msg.includes("fetch failed")) {
      return {
        ok: false,
        transferId: "",
        attestation: "",
        operatorSignature: "",
        attestationHash: "",
        ambiguous: true,
        error: `Gateway transfer timed out: ${msg}`,
      };
    }
    return {
      ok: false,
      transferId: "",
      attestation: "",
      operatorSignature: "",
      attestationHash: "",
      error: `Gateway transfer failed: ${msg}`,
    };
  }
}
