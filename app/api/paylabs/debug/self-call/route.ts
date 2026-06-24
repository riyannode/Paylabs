/**
 * GET /api/paylabs/debug/self-call
 *
 * Safe diagnostic: tests server-side self-call to Brain endpoint.
 * No payment signing. No secrets exposed.
 *
 * Returns only safe fields:
 * { ok, selectedBaseSource, sellerHostname, sellerPath,
 *   status, hasPaymentRequiredHeader, safeErrorClass }
 */

import { NextResponse } from "next/server";

async function resolveAppUrl(): Promise<string> {
  const base =
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    process.env.PAYLABS_INTERNAL_APP_URL ||
    process.env.PAYLABS_APP_URL ||
    "";
  if (!base) throw new Error("config_error: No VERCEL_URL or PAYLABS_APP_URL");
  return base.replace(/\/+$/, "");
}

export async function GET() {
  try {
    const base = await resolveAppUrl();
    const sellerUrl = `${base}/api/paylabs/brain/run`;

    // Determine which source was selected (safe — no value exposed)
    let selectedBaseSource = "unknown";
    if (process.env.VERCEL_URL) selectedBaseSource = "VERCEL_URL";
    else if (process.env.PAYLABS_INTERNAL_APP_URL)
      selectedBaseSource = "PAYLABS_INTERNAL_APP_URL";
    else if (process.env.PAYLABS_APP_URL) selectedBaseSource = "PAYLABS_APP_URL";

    const parsed = new URL(sellerUrl);

    // POST to brain endpoint without payment header
    const resp = await fetch(sellerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userGoal: "self-call health check",
        routeTier: "easy",
        userBudgetUsdc: 0.01,
        discoveryRunId: "debug-self-call",
      }),
      signal: AbortSignal.timeout(15000),
    });

    const hasPaymentRequiredHeader =
      resp.headers.has("payment-required") ||
      resp.headers.has("PAYMENT-REQUIRED");

    // Safe error class — read first 80 chars of body only if JSON
    let safeErrorClass = "none";
    const contentType = resp.headers.get("content-type") || "";
    if (resp.status !== 200 && resp.status !== 402) {
      try {
        const text = await resp.text();
        if (contentType.includes("json")) {
          const parsed = JSON.parse(text);
          safeErrorClass = (parsed.error || parsed.message || text)
            .toString()
            .substring(0, 80);
        } else {
          safeErrorClass = `non-json(${contentType.substring(0, 30)})`;
        }
      } catch {
        safeErrorClass = "unreadable";
      }
    }

    return NextResponse.json({
      ok: true,
      selectedBaseSource,
      sellerHostname: parsed.hostname,
      sellerPath: parsed.pathname,
      status: resp.status,
      hasPaymentRequiredHeader,
      safeErrorClass,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({
      ok: false,
      selectedBaseSource: "error",
      sellerHostname: "",
      sellerPath: "/api/paylabs/brain/run",
      status: 0,
      hasPaymentRequiredHeader: false,
      safeErrorClass: msg.substring(0, 80),
    });
  }
}
