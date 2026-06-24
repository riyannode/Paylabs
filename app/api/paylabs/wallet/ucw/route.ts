/**
 * UCW API route — single endpoint for all Circle User-Controlled Wallet operations.
 *
 * Actions:
 *   POST ?action=device-token        — create device token for social login
 *   POST ?action=initialize          — initialize user / create wallet challenge
 *   POST ?action=list-wallets        — list user wallets
 *   POST ?action=balance             — get wallet USDC balance
 *   POST ?action=sign-challenge      — create signTypedData challenge for x402
 *   POST ?action=deposit             — allowance-aware Gateway deposit (approve if needed)
 *   POST ?action=gateway-balance     — read Gateway deposited balance
 *   POST ?action=session-create      — create server-side session (httpOnly cookie)
 *   POST ?action=session-restore     — restore session state after OAuth redirect
 *   POST ?action=session-get-device  — get device token from session
 *   POST ?action=session-save-device — save device token to session
 *   POST ?action=session-save-login  — save userToken + finalize (init + list wallets)
 *   POST ?action=session-finalize-wallet — post-challenge: re-list wallets, store, fetch balance
 *   POST ?action=session-save-wallet — save walletId/walletAddress to session
 *   POST ?action=session-balance     — get wallet + Gateway balance from session
 *   POST ?action=session-destroy     — destroy session + clear cookie
 *
 * Security: All sensitive tokens stored server-side in Supabase ucw_sessions.
 *           Frontend only holds httpOnly ucw_sid cookie.
 *           Legacy body-token actions (initialize, list-wallets, balance) are 403 in production.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  createSession,
  getSession,
  updateSession,
  deleteSession,
  refreshSession,
  checkAllowance,
} from "@/lib/paylabs/ucw";
import {
  createDeviceToken,
  createEmailDeviceToken,
  createUser,
  createUserToken,
  initializeUser,
  listWallets,
  getWalletTokenBalance,
  createSignTypedDataChallenge,
  createApproveChallenge,
  createDepositChallenge,
  getGatewayBalance,
} from "@/lib/paylabs/ucw";

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

      case "gateway-balance": {
        const { address } = body as { address: string };
        if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });
        const result = await getGatewayBalance(address);
        return NextResponse.json(result);
      }

      // -------------------------------------------------------------------
      // Session-bound actions (userToken/walletId from server session)
      // -------------------------------------------------------------------
      case "sign-challenge": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const sess = await getSession(sid);
        if (!sess?.userToken || !sess?.walletId) return NextResponse.json({ error: "No wallet in session" }, { status: 400 });
        const { data } = body as { data: Record<string, unknown> };
        if (!data) return NextResponse.json({ error: "data required" }, { status: 400 });
        const result = await createSignTypedDataChallenge(sess.userToken, sess.walletId, data);
        await refreshSession(sid);
        const respSign = NextResponse.json(result);
        respSign.cookies.set("ucw_sid", sid, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 1800 });
        return respSign;
      }

      case "check-allowance": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const sess = await getSession(sid);
        if (!sess?.walletAddress) return NextResponse.json({ error: "No wallet in session" }, { status: 400 });
        const { isAddress } = await import("viem");
        if (!isAddress(sess.walletAddress)) return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
        const { amountAtomic: required } = body as { amountAtomic?: string };
        if (required && (!/^\d+$/.test(required) || BigInt(required) <= BigInt(0))) {
          return NextResponse.json({ error: "amountAtomic must be a positive integer string" }, { status: 400 });
        }
        const currentAllowance = await checkAllowance(sess.walletAddress);
        const sufficient = required ? BigInt(currentAllowance) >= BigInt(required) : BigInt(currentAllowance) > BigInt(0);
        await refreshSession(sid);
        return NextResponse.json({ allowance: currentAllowance, sufficient });
      }

      case "deposit": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const sess = await getSession(sid);
        if (!sess?.userToken || !sess?.walletId || !sess?.walletAddress) return NextResponse.json({ error: "No wallet in session" }, { status: 400 });
        const { amountAtomic } = body as { amountAtomic: string };
        if (!amountAtomic || !/^\d+$/.test(amountAtomic) || BigInt(amountAtomic) <= BigInt(0)) {
          return NextResponse.json({ error: "amountAtomic must be a positive integer string" }, { status: 400 });
        }
        // Validate wallet address
        const { isAddress } = await import("viem");
        if (!isAddress(sess.walletAddress)) {
          return NextResponse.json({ error: "Invalid wallet address in session" }, { status: 400 });
        }
        // On-chain allowance check
        const currentAllowance = await checkAllowance(sess.walletAddress);

        if (BigInt(currentAllowance) >= BigInt(amountAtomic)) {
          // Allowance sufficient — create deposit challenge only
          const deposit = await createDepositChallenge(sess.userToken, sess.walletId, amountAtomic);
          await refreshSession(sid);
          const resp = NextResponse.json({ step: "deposit_ready", depositChallengeId: deposit.challengeId ?? undefined });
          resp.cookies.set("ucw_sid", sid, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 1800 });
          return resp;
        }

        // Allowance insufficient — return approve challenge only (bounded cap: amount × 10)
        // Frontend must poll allowance after approve, then request deposit again
        const approveCap = (BigInt(amountAtomic) * BigInt(10)).toString();
        const approve = await createApproveChallenge(sess.userToken, sess.walletId, approveCap);
        await refreshSession(sid);
        const respDeposit = NextResponse.json({ step: "approve_required", approveChallengeId: approve.challengeId ?? undefined });
        respDeposit.cookies.set("ucw_sid", sid, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 1800 });
        return respDeposit;
      }

      // -------------------------------------------------------------------
      // Session management (httpOnly cookie, Supabase-backed)
      // -------------------------------------------------------------------
      case "session-create": {
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
        const origin = req.headers.get("origin") || req.headers.get("referer");
        const appUrl = process.env.PAYLABS_APP_URL || process.env.NEXT_PUBLIC_PAYLABS_APP_URL;
        if (appUrl && origin && !origin.startsWith(appUrl)) {
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

        // Fetch balances
        const [balances, gw] = await Promise.all([
          getWalletTokenBalance(walletId, session.userToken),
          getGatewayBalance(walletAddress),
        ]);
        const usdc = balances.find((b) => b.token === "USDC")?.amount ?? "0";

        const respFinalize = NextResponse.json({ ok: true, walletId, walletAddress, usdc, gateway: gw.balance });
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
        const [balances, gw] = await Promise.all([
          getWalletTokenBalance(session.walletId, session.userToken),
          session.walletAddress ? getGatewayBalance(session.walletAddress) : Promise.resolve({ balance: "0", domain: 26 }),
        ]);
        const usdc = balances.find((b) => b.token === "USDC")?.amount ?? "0";
        await refreshSession(sid);
        const resp = NextResponse.json({ usdc, gateway: gw.balance, walletAddress: session.walletAddress });
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
