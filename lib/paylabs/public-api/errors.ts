import { NextResponse } from "next/server";
import type { PublicApiErrorCode } from "./types";

const STATUS_BY_CODE: Record<PublicApiErrorCode, number> = {
  INVALID_REQUEST: 400,
  INVALID_ROUTE_TIER: 400,
  BUDGET_EXCEEDED: 400,
  PAYMENT_REQUIRED: 402,
  INVALID_PAYMENT: 402,
  PAYMENT_EXPIRED: 402,
  PAYMENT_REPLAYED: 409,
  PAYMENT_SETTLEMENT_FAILED: 402,
  PREFLIGHT_FAILED: 502,
  LOCKED_QUOTE_EXPIRED: 410,
  RUN_FAILED: 502,
  RUN_NOT_FOUND: 404,
  READ_TOKEN_INVALID: 403,
  GATEWAY_TEMPORARILY_UNAVAILABLE: 503,
};

export function publicError(code: PublicApiErrorCode, message: string, opts?: { status?: number; retryable?: boolean; runId?: string | null; headers?: HeadersInit; state?: "failed" | "payment_required" }) {
  return NextResponse.json({
    ok: false,
    status: opts?.state ?? (code === "PAYMENT_REQUIRED" ? "payment_required" : "failed"),
    error: { code, message, retryable: opts?.retryable ?? false },
    run_id: opts?.runId ?? null,
  }, { status: opts?.status ?? STATUS_BY_CODE[code], headers: opts?.headers });
}
