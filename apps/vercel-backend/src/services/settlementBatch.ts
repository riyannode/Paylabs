// Settlement batch service
// Groups accepted payments into batches of 5, syncs txHash from Gateway/Arc

import { config } from "../config.js";
import sql from "../db/client.js";

export interface SettlementBatch {
  id: string;
  status: "open" | "closed" | "settlement_pending" | "settled" | "failed";
  thresholdCount: number;
  currentCount: number;
  settlementRef: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  createdAt: Date;
  closedAt: Date | null;
  settledAt: Date | null;
}

export async function assignPaymentToBatch(paymentId: string): Promise<{
  batchId: string;
  batchPosition: number;
  batchStatus: string;
  closed: boolean;
}> {
  // Find or create open batch
  const [openBatch] = await sql`
    SELECT id, current_count, threshold_count
    FROM paylabs_settlement_batches
    WHERE status = 'open'
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE
  `;

  let batchId: string;
  let newCount: number;

  if (openBatch) {
    batchId = openBatch.id;
    newCount = openBatch.current_count + 1;
  } else {
    const [newBatch] = await sql`
      INSERT INTO paylabs_settlement_batches (status, threshold_count, current_count)
      VALUES ('open', ${config.settlementBatchThreshold}, 1)
      RETURNING id, current_count
    `;
    batchId = newBatch.id;
    newCount = 1;
  }

  const closed = newCount >= config.settlementBatchThreshold;
  const batchStatus = closed ? "settlement_pending" : "batch_pending";

  // Update batch count
  if (closed) {
    await sql`
      UPDATE paylabs_settlement_batches
      SET current_count = ${newCount},
          status = 'closed',
          closed_at = now()
      WHERE id = ${batchId}
    `;
  } else {
    await sql`
      UPDATE paylabs_settlement_batches
      SET current_count = ${newCount}
      WHERE id = ${batchId}
    `;
  }

  // Update payment attempt
  await sql`
    UPDATE paylabs_payment_attempts
    SET batch_id = ${batchId},
        batch_position = ${newCount},
        status = CASE WHEN ${closed} THEN 'settlement_pending' ELSE 'accepted' END,
        accepted_at = now()
    WHERE id = ${paymentId}
  `;

  // Create receipt
  await sql`
    INSERT INTO paylabs_receipts (
      user_id, payment_attempt_id, batch_id, batch_position,
      batch_status, site_id, purpose, title, amount_usdc,
      payment_id, authorization_hash, settlement_ref
    )
    SELECT
      pa.user_id, pa.id, ${batchId}, ${newCount},
      ${batchStatus}, pa.site_id, pa.purpose,
      COALESCE(ci.title, pa.resource_id), pa.amount_usdc,
      pa.payment_id, pa.authorization_hash, pa.settlement_ref
    FROM paylabs_payment_attempts pa
    LEFT JOIN paylabs_content_items ci ON ci.id = pa.resource_id
    WHERE pa.id = ${paymentId}
  `;

  return { batchId, batchPosition: newCount, batchStatus, closed };
}

export async function syncBatchTxHash(batchId: string): Promise<{
  updated: boolean;
  txHash: string | null;
}> {
  // TODO: Query Gateway/Arc for real settlement txHash
  // TODO: Update batch + all receipts in batch with txHash
  // TODO: Set explorer_url = config.arcExplorerTxBase + txHash
  throw new Error("Not implemented yet");
}
