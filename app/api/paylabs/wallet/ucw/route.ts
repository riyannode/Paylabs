/**
 * UCW API route — single endpoint for all Circle User-Controlled Wallet operations.
 *
 * Actions:
 *   POST ?action=device-token        — create device token for social login
 *   POST ?action=initialize          — initialize user / create wallet challenge
 *   POST ?action=list-wallets        — list user wallets
 *   POST ?action=balance             — get wallet USDC balance
 *   POST ?action=sign-challenge      — create signTypedData challenge for x402
 *   POST ?action=approve-deposit     — create approve+deposit challenges for Gateway
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
        const { userToken } = body as { userToken: string };
        if (!userToken) return NextResponse.json({ error: "userToken required" }, { status: 400 });
        const result = await initializeUser(userToken);
        return NextResponse.json(result);
      }

      case "list-wallets": {
        const { userToken } = body as { userToken: string };
        if (!userToken) return NextResponse.json({ error: "userToken required" }, { status: 400 });
        const wallets = await listWallets(userToken);
        return NextResponse.json({ wallets });
      }

      case "balance": {
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
        return NextResponse.json(result);
      }

      case "approve-deposit": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const sess = await getSession(sid);
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
        await updateSession(sid, { deviceId: did, deviceToken: dt, deviceEncryptionKey: dek });
        return NextResponse.json({ ok: true });
      }

      case "session-restore": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const session = await getSession(sid);
        if (!session) return NextResponse.json({ error: "Session expired" }, { status: 401 });
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
        const session = await getSession(sid);
        if (!session?.deviceToken) return NextResponse.json({ error: "No device token in session" }, { status: 404 });
        return NextResponse.json({ deviceToken: session.deviceToken, deviceEncryptionKey: session.deviceEncryptionKey });
      }

      case "session-save-login": {
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const { userToken: ut, encryptionKey: ek } = body as { userToken: string; encryptionKey: string };
        await updateSession(sid, { userToken: ut, encryptionKey: ek });
        // Finalize: initialize user + list wallets
        const initResult = await initializeUser(ut);
        let walletId: string | null = null;
        let walletAddress: string | null = null;
        if (!initResult.challengeId) {
          // Existing user — wallets already exist
          const wallets = await listWallets(ut);
          if (wallets.length > 0) {
            walletId = wallets[0].id;
            walletAddress = wallets[0].address;
            await updateSession(sid, { walletId, walletAddress });
          }
        }
        return NextResponse.json({
          ok: true,
          walletId,
          walletAddress,
          needsChallenge: !!initResult.challengeId,
          challengeId: initResult.challengeId,
        });
      }

      case "session-finalize-wallet": {
        // Called after sdk.execute(challengeId) completes — re-list wallets, store, fetch balance
        const sid = req.cookies.get("ucw_sid")?.value;
        if (!sid) return NextResponse.json({ error: "No session" }, { status: 401 });
        const session = await getSession(sid);
        if (!session?.userToken) return NextResponse.json({ error: "No userToken in session" }, { status: 400 });

        const wallets = await listWallets(session.userToken);
        if (wallets.length === 0) {
          return NextResponse.json({ ok: false, error: "No wallets found after challenge" }, { status: 404 });
        }

        const walletId = wallets[0].id;
        const walletAddress = wallets[0].address;
        await updateSession(sid, { walletId, walletAddress });

        // Fetch balances
        const [balances, gw] = await Promise.all([
          getWalletTokenBalance(walletId, session.userToken),
          getGatewayBalance(walletAddress),
        ]);
        const usdc = balances.find((b) => b.token === "USDC")?.amount ?? "0";

        return NextResponse.json({ ok: true, walletId, walletAddress, usdc, gateway: gw.balance });
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
        return NextResponse.json({ usdc, gateway: gw.balance, walletAddress: session.walletAddress });
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
