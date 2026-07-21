/**
 * POST /api/paylabs/withdrawal/reconcile — Run withdrawal reconciliation
 * GET  /api/paylabs/withdrawal/reconcile — Check reconciliation status
 *
 * Protected route — requires admin secret or internal cron auth.
 * Runs reconciliation on all stuck withdrawals.
 */

import { NextRequest, NextResponse } from "next/server";
import { runReconciliation } from "@/lib/paylabs/withdrawal/reconciliation";

// Simple auth: require admin secret header
function isAuthenticated(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization");
  const adminSecret = process.env.PAYLABS_RECONCILE_SECRET || process.env.PAYLABS_ADMIN_SECRET;
  if (!adminSecret) return false;
  return authHeader === `Bearer ${adminSecret}`;
}

export async function POST(req: NextRequest) {
  if (!isAuthenticated(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runReconciliation();
    return NextResponse.json({ ok: true, ...result });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[reconcile] Route error:", msg.slice(0, 200));
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  if (!isAuthenticated(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({ ok: true, message: "Reconciliation endpoint available. POST to run." });
}
