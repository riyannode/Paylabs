// Receipts service
// Retrieves receipts with batch status and txHash explorer links

import sql from "../db/client.js";

export interface Receipt {
  id: string;
  userId: string;
  paymentAttemptId: string;
  batchId: string | null;
  batchPosition: number | null;
  batchStatus: string | null;
  siteId: string;
  purpose: string;
  title: string;
  amountUsdc: string;
  paymentId: string | null;
  authorizationHash: string | null;
  settlementRef: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export async function getReceiptsForUser(userId: string): Promise<Receipt[]> {
  const rows = await sql`
    SELECT * FROM paylabs_receipts
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `;
  return rows as unknown as Receipt[];
}

export async function getReceiptById(id: string): Promise<Receipt | null> {
  const [row] = await sql`
    SELECT * FROM paylabs_receipts WHERE id = ${id}
  `;
  return (row as unknown as Receipt) ?? null;
}
