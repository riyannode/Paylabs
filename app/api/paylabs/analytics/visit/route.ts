import { NextRequest, NextResponse } from "next/server";
import { createHmac, randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/paylabs/db/server";

const COOKIE_NAME = "pl_vid";
const COOKIE_MAX_AGE = 180 * 24 * 60 * 60; // 180 days

const BOT_PATTERNS =
  /bot|crawler|spider|preview|vercel|uptime|monitor|curl|wget|headless|googlebot|bingbot|slurp/i;

function hashVisitorId(vid: string): string {
  const secret = process.env.PAYLABS_ANALYTICS_SECRET;
  if (!secret) return vid; // fail-safe: hash with vid itself if secret missing
  return createHmac("sha256", secret).update(vid).digest("hex");
}

function hashUserAgent(ua: string | null): string | null {
  if (!ua) return null;
  const secret = process.env.PAYLABS_ANALYTICS_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(ua).digest("hex");
}

function sanitizePath(p: string | null): string {
  if (!p) return "/";
  // Only allow path portion — strip query and fragment
  const url = new URL(p, "https://dummy.com");
  return url.pathname.slice(0, 500) || "/";
}

function sanitizeReferrer(r: string | null): string | null {
  if (!r) return null;
  try {
    const url = new URL(r);
    return url.origin + url.pathname.slice(0, 500);
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    // Read or create visitor ID from cookie
    let vid = req.cookies.get(COOKIE_NAME)?.value || null;
    let isNewVisitor = false;
    if (!vid) {
      vid = randomUUID();
      isNewVisitor = true;
    }

    // Hash for storage (never store raw vid in DB)
    const visitorHash = hashVisitorId(vid);

    // Parse body
    let path = "/";
    let referrer: string | null = null;
    try {
      const body = await req.json();
      path = sanitizePath(body?.path);
      referrer = sanitizeReferrer(body?.referrer);
    } catch {
      // Empty body — treat as homepage visit
    }

    // Detect bots from user-agent
    const ua = req.headers.get("user-agent") || "";
    const isBot = BOT_PATTERNS.test(ua);
    const userAgentHash = hashUserAgent(ua);

    // Insert visit
    const { error } = await supabaseAdmin().from("paylabs_page_visits").insert({
      visitor_hash: visitorHash,
      path,
      referrer,
      user_agent_hash: userAgentHash,
      is_bot: isBot,
    });

    if (error) {
      console.error("[analytics/visit] insert failed:", error.message);
      // Still return ok to the client — tracking failure must not break the site
    }

    // Set cookie
    const cookieValue = isNewVisitor ? vid : undefined;
    const resp = NextResponse.json({ ok: true });

    if (isNewVisitor && cookieValue) {
      resp.cookies.set(COOKIE_NAME, cookieValue, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: COOKIE_MAX_AGE,
      });
    }

    return resp;
  } catch {
    // Fail-safe: never break the site
    return NextResponse.json({ ok: true });
  }
}
