/**
 * UCW API route — Creator Wallet only.
 *
 * Supported actions:
 *   POST ?action=device-token
 *   POST ?action=email-device-token
 *   POST ?action=create-user
 *   POST ?action=user-token
 *   POST ?action=session-create
 *   POST ?action=session-restore
 *   POST ?action=session-get-device
 *   POST ?action=session-save-device
 *   POST ?action=session-get-auth
 *   POST ?action=session-save-login
 *   POST ?action=session-finalize-wallet
 *   POST ?action=session-save-wallet
 *   POST ?action=session-balance
 *   POST ?action=session-destroy
 *
 * Security: All sensitive tokens are stored server-side in Supabase ucw_sessions.
 *           Frontend only holds the httpOnly ucw_sid cookie.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  createSession,
  getSession,
  updateSession,
  deleteSession,
  refreshSession,
} from "@/lib/paylabs/ucw";
import {
  createDeviceToken,
  createEmailDeviceToken,
  createUser,
  createUserToken,
  initializeUser,
  listWallets,
  getWalletTokenBalance,
} from "@/lib/paylabs/ucw";
import { getSession as getDcwSession } from "@/lib/paylabs/auth/session";

/** Parse body safely — empty POST bodies are valid for session actions */
async function safeParseBody(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

export async function POST(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");
  if (!action) {
    return NextResponse.json({ error: "Missing ?action param" }, { status: 400 });
  }

  try {
    const body = await safeParseBody(req);

    switch (action) {
      // -------------------------------------------------------------------
      // Circle API pass-through actions (userToken from body — legacy)
      // -------------------------------------------------------------------
      case "device-token": {
        const { deviceId } = body as { deviceId: string };
        if (!deviceId) return NextResponse.json({ error: "deviceId required" }, { status: 400 });
        const result = await createDeviceToken(deviceId);
        return NextResponse.json(result);
      }

      case "create-user": {
        const { userId } = body as { userId: string };
        if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });
        const result = await createUser(userId);
        return NextResponse.json(result);
      }

      case "initialize": {
        if (process.env.NODE_ENV === "production") return NextResponse.json({ error: "Use session-bound actions" }, { status: 403 });
        const { userToken } = body as { userToken: string };
        if (!userToken) return NextResponse.json({ error: "userToken required" }, { status: 400 });
        const result = await initializeUser(userToken);
        return NextResponse.json(result);
      }

      case "list-wallets": {
        if (process.env.NODE_ENV === "production") return NextResponse.json({ error: "Use session-bound actions" }, { status: 403 });
        const { userToken } = body as { userToken: string };
        if (!userToken) return NextResponse.json({ error: "userToken required" }, { status: 400 });
        const wallets = await listWallets(userToken);
        return NextResponse.json({ wallets });
      }

      case "balance": {
        if (process.env.NODE_ENV === "production") return NextResponse.json({ error: "Use session-bound actions" }, { status: 403 });
        const { walletId, userToken } = body as { walletId: string; userToken: string };
        if (!walletId || !userToken) {
          return NextResponse.json({ error: "walletId and userToken required" }, { status: 400 });
        }
        const balances = await getWalletTokenBalance(walletId, userToken);
        return NextResponse.json({ balances });
      }

      case "email-device-token": {
        const { deviceId, email } = body as { deviceId: string; email: string };
        if (!deviceId || !email) return NextResponse.json({ error: "deviceId and email required" }, { status: 400 });
        const result = await createEmailDeviceToken(deviceId, email);
        return NextResponse.json(result);
      }

      case "user-token": {
        const { userId } = body as { userId: string };
        if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });
        const result = await createUserToken(userId);
        return NextResponse.json(result);
      }

      // -------------------------------------------------------------------
      // Session-bound actions (userToken/walletId from server session)
      // -------------------------------------------------------------------
      case "sign-challenge":
      case "check-allowance":
      case "deposit":
      case "gateway-balance": {
        return NextResponse.json(
          {
            error: "Creator Wallet does not support x402/Gateway actions. Use User Test Wallet for x402 payments.",
            activeWalletMode: "ucw_creator_only",
          },
          { status: 410 },
        );
      }

      // -------------------------------------------------------------------
      // Session management (httpOnly cookie, Supabase-backed)
      // -------------------------------------------------------------------
      case "session-create": {
        const dcwSession = await getDcwSession();
        if (dcwSession?.walletAddress) {
          console.error("[UCW API]", {
            action,
            status: 409,
            reason: "wallet_mode_conflict",
            activeWalletMode: "dcw",
          });
          return NextResponse.json(
            {
              error: "User Test Wallet is already connected. Disconnect it before connecting Creator Wallet.",
              activeWalletMode: "dcw",
            },
            { status: 409 },
          );
        }

        const sid = await createSession();
        const resp = NextResponse.json({ ok: true });
        resp.cookies.set("ucw_sid", sid, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 1800 });
        return resp;
      }

      case "session-save-device": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const { deviceId: did, deviceToken: dt, deviceEncryptionKey: dek } = body as { deviceId: string; deviceToken: string; deviceEncryptionKey: string };
        const updated = await updateSession(sid, { deviceId: did, deviceToken: dt, deviceEncryptionKey: dek });
        if (!updated) return NextResponse.json({ error: "Session save device failed" }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      case "session-restore": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const session = await getSession(sid);
        if (!session) return NextResponse.json({ error: "Session expired" }, { status: 401 });
        await refreshSession(sid);
        const resp = NextResponse.json({
          hasDeviceToken: !!session.deviceToken,
          hasUserToken: !!session.userToken,
          walletId: session.walletId || null,
          walletAddress: session.walletAddress || null,
          authMethod: session.authMethod || "",
        });
        resp.cookies.set("ucw_sid", sid, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 1800 });
        return resp;
      }

      case "session-get-device": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const session = await getSession(sid);
        if (!session?.deviceToken) return NextResponse.json({ error: "No device token in session" }, { status: 404 });
        await refreshSession(sid);
        return NextResponse.json({ deviceToken: session.deviceToken, deviceEncryptionKey: session.deviceEncryptionKey });
      }

      case "session-get-auth": {
        // Returns auth tokens for SDK re-initialization after page refresh.
        // Security hardening:
        // 1. Origin check — only same-origin requests allowed
        // 2. Custom header required — browsers don't send custom headers cross-origin (CSRF protection)
        // 3. Cache: no-store — never cache auth tokens
        // 4. Tokens are behind httpOnly cookie — only reachable from same-origin with valid session
        const appUrl = process.env.PAYLABS_APP_URL || process.env.NEXT_PUBLIC_PAYLABS_APP_URL;
        if (!appUrl) {
          return NextResponse.json({ error: "App URL not configured" }, { status: 500 });
        }
        const requestOriginRaw = req.headers.get("origin") || req.headers.get("referer");
        if (!requestOriginRaw) {
          return NextResponse.json({ error: "Missing origin" }, { status: 403 });
        }
        let requestOrigin: string;
        let allowedOrigin: string;
        try {
          requestOrigin = new URL(requestOriginRaw).origin;
          allowedOrigin = new URL(appUrl).origin;
        } catch {
          return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
        }
        if (requestOrigin !== allowedOrigin) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        // Require X-Requested-With header (simple CSRF: cross-origin JS can't set custom headers)
        if (req.headers.get("x-requested-with") !== "ucw-sdk-restore") {
          return NextResponse.json({ error: "Missing required header" }, { status: 403 });
        }
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const session = await getSession(sid);
        if (!session?.userToken) return NextResponse.json({ error: "No user token in session" }, { status: 404 });
        await refreshSession(sid);
        const respAuth = NextResponse.json({
          userToken: session.userToken,
          encryptionKey: session.encryptionKey || null,
          authMethod: session.authMethod || "",
        });
        respAuth.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
        respAuth.headers.set("Pragma", "no-cache");
        respAuth.cookies.set("ucw_sid", sid, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 1800 });
        return respAuth;
      }

      case "session-save-login": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const { userToken: ut, encryptionKey: ek, authMethod: am } = body as { userToken: string; encryptionKey: string; authMethod?: string };
        const authMethod = (am === "google" || am === "email" || am === "pin") ? am : "";
        const updatedLogin = await updateSession(sid, { userToken: ut, encryptionKey: ek, authMethod });
        if (!updatedLogin) return NextResponse.json({ error: "Session save login failed" }, { status: 500 });
        // Finalize: initialize user + list wallets
        const initResult = await initializeUser(ut);
        let walletId: string | null = null;
        let walletAddress: string | null = null;
        if (!initResult.challengeId) {
          // Existing user — wallets should already exist
          const wallets = await listWallets(ut);
          if (wallets.length === 0) {
            return NextResponse.json(
              { error: "No Circle wallet found after login and no wallet creation challenge returned" },
              { status: 404 }
            );
          }
          walletId = wallets[0].id;
          walletAddress = wallets[0].address;
          const updatedW = await updateSession(sid, { walletId, walletAddress });
          if (!updatedW) return NextResponse.json({ error: "Session save wallet failed" }, { status: 500 });
        }
        const respLogin = NextResponse.json({
          ok: true,
          walletId,
          walletAddress,
          needsChallenge: !!initResult.challengeId,
          challengeId: initResult.challengeId,
        });
        respLogin.cookies.set("ucw_sid", sid, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 1800 });
        return respLogin;
      }

      case "session-finalize-wallet": {
        // Called after sdk.execute(challengeId) completes — re-list wallets, store, fetch balance
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const session = await getSession(sid);
        if (!session?.userToken) return NextResponse.json({ error: "No userToken in session" }, { status: 400 });

        // Poll for wallet — Circle indexes async after challenge completes
        let wallets: Awaited<ReturnType<typeof listWallets>> = [];
        for (let attempt = 0; attempt < 5; attempt++) {
          wallets = await listWallets(session.userToken);
          if (wallets.length > 0) break;
          if (attempt < 4) await new Promise((r) => setTimeout(r, 2000));
        }
        if (wallets.length === 0) {
          return NextResponse.json({ ok: false, error: "No wallets found after challenge (polled 5x)" }, { status: 404 });
        }

        const walletId = wallets[0].id;
        const walletAddress = wallets[0].address;
        const updatedWallet = await updateSession(sid, { walletId, walletAddress });
        if (!updatedWallet) return NextResponse.json({ error: "Session save wallet failed" }, { status: 500 });

        // Fetch wallet token balance only.
        const balances = await getWalletTokenBalance(walletId, session.userToken);
        const usdc = balances.find((b) => b.token === "USDC")?.amount ?? "0";

        const respFinalize = NextResponse.json({ ok: true, walletId, walletAddress, usdc });
        respFinalize.cookies.set("ucw_sid", sid, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 1800 });
        return respFinalize;
      }

      case "session-save-wallet": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const { walletId: wid, walletAddress: wa } = body as { walletId: string; walletAddress: string };
        await updateSession(sid, { walletId: wid, walletAddress: wa });
        return NextResponse.json({ ok: true });
      }

      case "session-balance": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const session = await getSession(sid);
        if (!session?.walletId || !session?.userToken) return NextResponse.json({ error: "No wallet in session" }, { status: 400 });
        const balances = await getWalletTokenBalance(session.walletId, session.userToken);
        const usdc = balances.find((b) => b.token === "USDC")?.amount ?? "0";
        await refreshSession(sid);
        const resp = NextResponse.json({ usdc, walletAddress: session.walletAddress });
        resp.cookies.set("ucw_sid", sid, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 1800 });
        return resp;
      }

      case "session-destroy": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (sid) await deleteSession(sid);
        const resp = NextResponse.json({ ok: true });
        resp.cookies.delete("ucw_sid");
        return resp;
      }

      // -------------------------------------------------------------------
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[UCW API] action=%s error: %s", action, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
