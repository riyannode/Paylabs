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
 * CIRCLE_API_KEY stays server-side via lib/paylabs/ucw.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  createDeviceToken,
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
        const { userToken, walletId, data } = body as {
          userToken: string;
          walletId: string;
          data: Record<string, unknown>;
        };
        if (!userToken || !walletId || !data) {
          return NextResponse.json(
            { error: "userToken, walletId, and data required" },
            { status: 400 },
          );
        }
        const result = await createSignTypedDataChallenge(userToken, walletId, data);
        return NextResponse.json(result);
      }

      // -------------------------------------------------------------------
      case "approve-deposit": {
        const { userToken, walletId, amountAtomic } = body as {
          userToken: string;
          walletId: string;
          amountAtomic: string;
        };
        if (!userToken || !walletId || !amountAtomic) {
          return NextResponse.json(
            { error: "userToken, walletId, and amountAtomic required" },
            { status: 400 },
          );
        }
        const approve = await createApproveChallenge(userToken, walletId, amountAtomic);
        const deposit = await createDepositChallenge(userToken, walletId, amountAtomic);
        return NextResponse.json({
          approve: { challengeId: approve.challengeId },
          deposit: { challengeId: deposit.challengeId },
        });
      }

      // -------------------------------------------------------------------
      case "gateway-balance": {
        const { address } = body as { address: string };
        if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });
        const result = await getGatewayBalance(address);
        return NextResponse.json(result);
      }

      // -------------------------------------------------------------------
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[UCW API] action=${action} error:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
