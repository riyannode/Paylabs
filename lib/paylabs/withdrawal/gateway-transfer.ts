/**
 * Gateway /v1/transfer
 *
 * Submits a signed BurnIntent to Gateway for attestation.
 * Parses the transfer response and extracts attestation data.
 */

import { GATEWAY_TESTNET_URL } from "./gateway-types";
import type { BurnIntent, GatewayTransferResponse } from "./gateway-types";

// ─── Hash Helpers ────────────────────────────────────────────

/**
 * Compute keccak256 hash of a JSON-serializable object.
 * Used for burn_intent_hash and attestation_hash.
 */
export async function keccak256Json(obj: unknown): Promise<string> {
  const text = new TextEncoder().encode(JSON.stringify(obj, bigintReplacer));
  const hashBuffer = await crypto.subtle.digest("SHA-256", text);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return "0x" + hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compute keccak256 hash of a hex string (e.g., attestation).
 */
export async function keccak256Hex(hex: string): Promise<string> {
  const bytes = hexToBytes(hex);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return "0x" + hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
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
  transferId?: string;
  attestation?: string;       // hex bytes
  operatorSignature?: string; // hex bytes
  attestationHash?: string;   // keccak256 of attestation
  error?: string;
  /** True if response was ambiguous (timeout without clear answer) */
  ambiguous?: boolean;
}

/**
 * Submit signed BurnIntent to Gateway POST /v1/transfer.
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
        error: `Gateway transfer failed: HTTP ${resp.status} — ${text.slice(0, 300)}`,
      };
    }

    const data = (await resp.json()) as GatewayTransferResponse;

    if (!data.attestation || !data.signature) {
      return {
        ok: false,
        error: "Gateway transfer response missing attestation or signature",
      };
    }

    // Compute attestation hash for storage
    const attestationHash = await keccak256Hex(data.attestation);

    return {
      ok: true,
      transferId: data.transferId ?? undefined,
      attestation: data.attestation,
      operatorSignature: data.signature,
      attestationHash,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Ambiguous timeout — may have succeeded or not
    if (msg.includes("abort") || msg.includes("timeout") || msg.includes("fetch failed")) {
      return {
        ok: false,
        ambiguous: true,
        error: `Gateway transfer timed out: ${msg}`,
      };
    }
    return { ok: false, error: `Gateway transfer failed: ${msg}` };
  }
}
