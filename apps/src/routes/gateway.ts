// Gateway routes — live Circle Gateway API integration
// Hard rules: no fake balance, no mock deposit, no dev bypass, no DB-only balance

import { Hono } from "hono";
import { jwtAuth } from "../middleware/jwt.js";
import {
  getBalance,
  getPendingDeposits,
  getDepositInstructions,
  validateGatewayConfig,
  GatewayApiError,
  GatewayConfigError,
} from "../services/circleGateway.js";

export const gatewayRoutes = new Hono();

// GET /api/gateway/status
// Returns real Gateway balance/status from Circle for the authenticated wallet
gatewayRoutes.get("/status", jwtAuth, async (c) => {
  try {
    validateGatewayConfig();
  } catch (err) {
    if (err instanceof GatewayConfigError) {
      return c.json({ error: "Gateway misconfigured", detail: err.message }, 503);
    }
    throw err;
  }

  const walletAddress = (c as any).get("walletAddress") as string;

  try {
    const [balanceResult, pendingDeposits] = await Promise.all([
      getBalance(walletAddress),
      getPendingDeposits(walletAddress),
    ]);

    return c.json({
      walletAddress,
      gateway: {
        token: balanceResult.token,
        totalBalance: balanceResult.totalBalance,
        balances: balanceResult.balances,
        pendingDeposits,
      },
      network: "arc-testnet",
      lastSyncedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof GatewayApiError) {
      const status = (err.status >= 500 ? 502 : err.status) as 401 | 403 | 404 | 500 | 502 | 503;
      return c.json(
        { error: "Gateway API unavailable", detail: err.message },
        status
      );
    }
    throw err;
  }
});

// POST /api/gateway/deposit-instructions
// Returns official on-chain deposit instructions (contract addresses, ABI, params)
// User/wallet must execute the approve + deposit transactions themselves
gatewayRoutes.post("/deposit-instructions", jwtAuth, async (c) => {
  try {
    validateGatewayConfig();
  } catch (err) {
    if (err instanceof GatewayConfigError) {
      return c.json({ error: "Gateway misconfigured", detail: err.message }, 503);
    }
    throw err;
  }

  const walletAddress = (c as any).get("walletAddress") as string;

  try {
    const instructions = getDepositInstructions();
    return c.json({
      walletAddress,
      instructions,
    });
  } catch (err) {
    if (err instanceof GatewayConfigError) {
      return c.json({ error: err.message }, 503);
    }
    throw err;
  }
});

// POST /api/gateway/sync
// Refreshes live Gateway balance/status from Circle
gatewayRoutes.post("/sync", jwtAuth, async (c) => {
  try {
    validateGatewayConfig();
  } catch (err) {
    if (err instanceof GatewayConfigError) {
      return c.json({ error: "Gateway misconfigured", detail: err.message }, 503);
    }
    throw err;
  }

  const walletAddress = (c as any).get("walletAddress") as string;

  try {
    const [balanceResult, pendingDeposits] = await Promise.all([
      getBalance(walletAddress),
      getPendingDeposits(walletAddress),
    ]);

    return c.json({
      walletAddress,
      gateway: {
        token: balanceResult.token,
        totalBalance: balanceResult.totalBalance,
        balances: balanceResult.balances,
        pendingDeposits,
      },
      lastSyncedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof GatewayApiError) {
      const status = (err.status >= 500 ? 502 : err.status) as 401 | 403 | 404 | 500 | 502 | 503;
      return c.json(
        { error: "Gateway API unavailable", detail: err.message },
        status
      );
    }
    throw err;
  }
});
