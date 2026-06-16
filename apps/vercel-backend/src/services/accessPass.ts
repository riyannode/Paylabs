// Access pass service
// Creates and checks access passes for content after payment

import sql from "../db/client.js";

export interface AccessPass {
  id: string;
  userId: string;
  walletAddress: string;
  contentId: string;
  siteId: string;
  targetUrl: string;
  paymentAttemptId: string;
  expiresAt: Date | null;
  createdAt: Date;
}

export async function createAccessPass(params: {
  userId: string;
  walletAddress: string;
  contentId: string;
  siteId: string;
  targetUrl: string;
  paymentAttemptId: string;
}): Promise<AccessPass> {
  const [pass] = await sql`
    INSERT INTO access_passes (user_id, wallet_address, content_id, site_id, target_url, payment_attempt_id)
    VALUES (${params.userId}, ${params.walletAddress}, ${params.contentId}, ${params.siteId}, ${params.targetUrl}, ${params.paymentAttemptId})
    RETURNING *
  `;
  return pass as AccessPass;
}

export async function checkAccessPass(userId: string, contentId: string): Promise<boolean> {
  const [pass] = await sql`
    SELECT id FROM access_passes
    WHERE user_id = ${userId} AND content_id = ${contentId}
    LIMIT 1
  `;
  return !!pass;
}
