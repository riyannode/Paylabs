/**
 * UCW API route — single endpoint for all Circle User-Controlled Wallet operations.
 *
 * Actions:
 *   POST ?action=device-token     — create device token for social login
 *   POST ?action=initialize       — initialize user / create wallet challenge
 *   POST ?action=list-wallets     — list user wallets
 *   POST ?action=balance          — get wallet USDC balance
 *   POST ?action=sign-challenge   — create signTypedData challenge for x402
 *   POST ?action=approve-deposit  — create approve+deposit challenges for Gateway
 *   POST ?action=gateway-balance  — read Gateway deposited balance
 *
 * Security: userToken comes from frontend (set during social login auth).
 * SECURITY: CIRCLE_API_KEY stays server-side via lib/paylabs/ucw.ts.
 *
 * TODO(#27-prod): userToken is received from request body. This is acceptable for
 * the memory-only prototype but production must use httpOnly signed sessions or
 * server-side session boundary. Sensitive routes (sign-challenge, approve-deposit)
 * should validate session ownership before calling Circle API.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  createSession,
  getSession,
  updateSession,
  deleteSession,
} from "@/lib/paylabs/ucw";
import {
  createDeviceToken,
  createEmailDeviceToken,
  createUserToken,
  initializeUser,
  listWallets,
  getWalletTokenBalance,
  createSignTypedDataChallenge,
  createApproveChallenge,
  createDepositChallenge,
  getGatewayBalance,
} from "@/lib/paylabs/ucw";

export async function POST(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");
  if (!action) {
    return NextResponse.json({ error: "Missing ?action param" }, { status: 400 });
  }

  try {
    const body = await req.json();

    switch (action) {
      // -------------------------------------------------------------------
      case "device-token": {
        const { deviceId } = body as { deviceId: string };
        if (!deviceId) return NextResponse.json({ error: "deviceId required" }, { status: 400 });
        const result = await createDeviceToken(deviceId);
        return NextResponse.json(result);
      }

      // -------------------------------------------------------------------
      case "initialize": {
        const { userToken } = body as { userToken: string };
        if (!userToken) return NextResponse.json({ error: "userToken required" }, { status: 400 });
        const result = await initializeUser(userToken);
        return NextResponse.json(result);
      }

      // -------------------------------------------------------------------
      case "list-wallets": {
        const { userToken } = body as { userToken: string };
        if (!userToken) return NextResponse.json({ error: "userToken required" }, { status: 400 });
        const wallets = await listWallets(userToken);
        return NextResponse.json({ wallets });
      }

      // -------------------------------------------------------------------
      case "balance": {
        const { walletId, userToken } = body as { walletId: string; userToken: string };
        if (!walletId || !userToken) {
          return NextResponse.json({ error: "walletId and userToken required" }, { status: 400 });
        }
        const balances = await getWalletTokenBalance(walletId, userToken);
        return NextResponse.json({ balances });
      }

      // -------------------------------------------------------------------
      case "sign-challenge": {
        // Read userToken/walletId from server session (httpOnly cookie)
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const sess = getSession(sid);
        if (!sess?.userToken || !sess?.walletId) return NextResponse.json({ error: "No wallet in session" }, { status: 400 });
        const { data } = body as { data: Record<string, unknown> };
        if (!data) return NextResponse.json({ error: "data required" }, { status: 400 });
        const result = await createSignTypedDataChallenge(sess.userToken, sess.walletId, data);
        return NextResponse.json(result);
      }

      // -------------------------------------------------------------------
      case "approve-deposit": {
        // Read userToken/walletId from server session (httpOnly cookie)
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const sess = getSession(sid);
        if (!sess?.userToken || !sess?.walletId) return NextResponse.json({ error: "No wallet in session" }, { status: 400 });
        const { amountAtomic } = body as { amountAtomic: string };
        if (!amountAtomic) return NextResponse.json({ error: "amountAtomic required" }, { status: 400 });
        const approve = await createApproveChallenge(sess.userToken, sess.walletId, amountAtomic);
        const deposit = await createDepositChallenge(sess.userToken, sess.walletId, amountAtomic);
        return NextResponse.json({
          approve: { challengeId: approve.challengeId },
          deposit: { challengeId: deposit.challengeId },
        });
      }

      // -------------------------------------------------------------------
      case "email-device-token": {
        const { deviceId, email } = body as { deviceId: string; email: string };
        if (!deviceId || !email) return NextResponse.json({ error: "deviceId and email required" }, { status: 400 });
        const result = await createEmailDeviceToken(deviceId, email);
        return NextResponse.json(result);
      }

      // -------------------------------------------------------------------
      case "user-token": {
        const { userId } = body as { userId: string };
        if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });
        const result = await createUserToken(userId);
        return NextResponse.json(result);
      }

      // -------------------------------------------------------------------
      case "gateway-balance": {
        const { address } = body as { address: string };
        if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });
        const result = await getGatewayBalance(address);
        return NextResponse.json(result);
      }

      // -------------------------------------------------------------------
      // Session management (httpOnly cookie-based)
      // -------------------------------------------------------------------
      case "session-create": {
        const sid = createSession();
        const resp = NextResponse.json({ ok: true });
        resp.cookies.set("ucw_sid", sid, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 1800 });
        return resp;
      }

      case "session-save-device": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const { deviceId: did, deviceToken: dt, deviceEncryptionKey: dek } = body as { deviceId: string; deviceToken: string; deviceEncryptionKey: string };
        updateSession(sid, { deviceId: did, deviceToken: dt, deviceEncryptionKey: dek });
        return NextResponse.json({ ok: true });
      }

      case "session-restore": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const session = getSession(sid);
        if (!session) return NextResponse.json({ error: "Session expired" }, { status: 401 });
        // Return only what frontend needs to re-init SDK (not userToken)
        return NextResponse.json({
          hasDeviceToken: !!session.deviceToken,
          hasUserToken: !!session.userToken,
          walletId: session.walletId || null,
          walletAddress: session.walletAddress || null,
        });
      }

      case "session-get-device": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const session = getSession(sid);
        if (!session?.deviceToken) return NextResponse.json({ error: "No device token in session" }, { status: 404 });
        return NextResponse.json({ deviceToken: session.deviceToken, deviceEncryptionKey: session.deviceEncryptionKey });
      }

      case "session-save-login": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const { userToken: ut, encryptionKey: ek } = body as { userToken: string; encryptionKey: string };
        updateSession(sid, { userToken: ut, encryptionKey: ek });
        // Now finalize: initialize user + list wallets server-side
        const session = getSession(sid)!;
        const initResult = await initializeUser(ut);
        let walletId = session.walletId;
        let walletAddress = session.walletAddress;
        if (!walletId) {
          const wallets = await listWallets(ut);
          if (wallets.length > 0) {
            walletId = wallets[0].id;
            walletAddress = wallets[0].address;
            updateSession(sid, { walletId, walletAddress });
          }
        }
        return NextResponse.json({
          ok: true,
          walletId: walletId || null,
          walletAddress: walletAddress || null,
          needsChallenge: !!initResult.challengeId,
          challengeId: initResult.challengeId,
        });
      }

      case "session-save-wallet": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const { walletId: wid, walletAddress: wa } = body as { walletId: string; walletAddress: string };
        updateSession(sid, { walletId: wid, walletAddress: wa });
        return NextResponse.json({ ok: true });
      }

      case "session-balance": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const session = getSession(sid);
        if (!session?.walletId || !session?.userToken) return NextResponse.json({ error: "No wallet in session" }, { status: 400 });
        const [balances, gw] = await Promise.all([
          getWalletTokenBalance(session.walletId, session.userToken),
          session.walletAddress ? getGatewayBalance(session.walletAddress) : Promise.resolve({ balance: "0", domain: 26 }),
        ]);
        const usdc = balances.find((b) => b.token === "USDC")?.amount ?? "0";
        return NextResponse.json({ usdc, gateway: gw.balance, walletAddress: session.walletAddress });
      }

      case "session-destroy": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (sid) deleteSession(sid);
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
