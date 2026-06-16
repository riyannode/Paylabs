// Idempotency service
// Prevents duplicate payment processing

import { createHash } from "crypto";
import sql from "../db/client.js";

export function generateIdempotencyKey(walletAddress: string, resourceId: string, purpose: string): string {
  return createHash("sha256")
    .update(`${walletAddress}:${resourceId}:${purpose}`)
    .digest("hex");
}

export async function checkIdempotency(key: string): Promise<{ exists: boolean; paymentId?: string }> {
  const [row] = await sql`
    SELECT id FROM payment_attempts WHERE idempotency_key = ${key} AND status IN ('accepted', 'settlement_pending', 'settled')
  `;
  return row ? { exists: true, paymentId: (row as { id: string }).id } : { exists: false };
}
