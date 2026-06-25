/**
 * GET /api/paylabs/debug/self-call
 *
 * Safe diagnostic: tests server-side self-call to Brain endpoint.
 * No payment signing. No secrets exposed.
 *
 * REQUIRES: Authorization: Bearer <PAYLABS_INTERNAL_HEALTH_TOKEN>
 *
 * Returns only safe fields:
 * { ok, selectedBaseSource, sellerHostname, sellerPath,
 *   status, hasPaymentRequiredHeader, safeErrorClass }
 */

import { NextRequest, NextResponse } from "next/server";
import { resolvePaylabsAppUrl } from "@/lib/paylabs/runtime/resolve-app-url";

export async function GET(req: NextRequest) {
  // --- Auth gate: require internal token + non-production env ---
  if (process.env.NODE_ENV === "production" && !process.env.PAYLABS_DEBUG_ROUTES_ENABLED) {
    return NextResponse.json(
      { ok: false, error: "Debug routes disabled in production" },
      { status: 403 },
    );
  }
  const expectedToken = process.env.PAYLABS_INTERNAL_HEALTH_TOKEN;
  if (!expectedToken) {
    return NextResponse.json(
      { ok: false, error: "Debug endpoint not configured" },
      { status: 503 },
    );
  }
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token || token !== expectedToken) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }
  // --- End auth gate ---

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
