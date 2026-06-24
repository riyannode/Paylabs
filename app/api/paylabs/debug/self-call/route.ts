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
import { resolvePaylabsAppUrl } from "@/lib/paylabs/runtime/resolve-app-url";

export async function GET() {
  try {
    const { baseUrl, source: selectedBaseSource, hostname: sellerHostname } =
      resolvePaylabsAppUrl();

    const sellerUrl = `${baseUrl}/api/paylabs/brain/run`;
    const sellerPath = "/api/paylabs/brain/run";

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
      sellerHostname,
      sellerPath,
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
