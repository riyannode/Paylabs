/**
 * Circle Gateway Balance Verification
 *
 * Checks DCW EOA agent wallet balances via the Gateway REST API
 * before attempting x402 payment signing. Fail closed if insufficient.
 *
 * Gateway REST API is permissionless — no API key needed for /v1/balances.
 * Balance is returned in human-readable USDC (already divided by 10^6).
 *
 * Prerequisite: DCW wallets must have USDC deposited into Circle Gateway.
 * Deposit is on-chain only (approve + deposit on Gateway Wallet contract).
 */

// ─── Types ─────────────────────────────────────────────────────

export interface GatewayBalanceResult {
  /** Whether the check succeeded (Gateway reachable + balance returned) */
  ok: boolean;
  /** Human-readable USDC balance (e.g. "0.001500") */
  balanceUsdc?: string;
  /** Balance in atomic units (6 decimals) */
  balanceAtomic?: string;
  /** USDC locked in pending batch settlement */
  pendingBatchUsdc?: string;
  /** Error message if check failed */
  error?: string;
}

export interface CheckGatewayBalanceInput {
  /** Wallet address (0x...) — the DCW EOA address */
  depositor: string;
  /** Arc Testnet domain = 26 */
  domain?: number;
}

// ─── Constants ─────────────────────────────────────────────────

const GATEWAY_TESTNET_URL = "https://gateway-api-testnet.circle.com/v1";
const ARC_TESTNET_DOMAIN = 26;

// ─── Core Function ─────────────────────────────────────────────

/**
 * Check a DCW wallet's Gateway balance on Arc Testnet.
 *
 * Returns the unified USDC balance available for x402 payments.
 * Fails closed: if Gateway is unreachable or returns an error,
 * returns ok:false with error detail.
 *
 * Never exposes raw Gateway response — only safe summary fields.
 */
export async function checkGatewayBalance(
  input: CheckGatewayBalanceInput
): Promise<GatewayBalanceResult> {
  const { depositor, domain = ARC_TESTNET_DOMAIN } = input;

  if (!depositor || !depositor.startsWith("0x") || depositor.length !== 42) {
    return { ok: false, error: "Invalid depositor address" };
  }

  const gatewayUrl = process.env.PAYLABS_GATEWAY_API_URL || GATEWAY_TESTNET_URL;
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(`${gatewayUrl}/balances`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "USDC",
          sources: [{ domain, depositor: depositor.toLowerCase() }],
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) {
        // Non-retryable HTTP error
        return {
          ok: false,
          error: `Gateway balance check failed: HTTP ${resp.status}`,
        };
      }

      const data = await resp.json() as {
        token?: string;
        balances?: Array<{
          domain: number;
          depositor: string;
          balance: string;
          pendingBatch?: string;
        }>;
      };

      const balanceEntry = data.balances?.[0];
      if (!balanceEntry) {
        return {
          ok: true,
          balanceUsdc: "0",
          balanceAtomic: "0",
          pendingBatchUsdc: "0",
        };
      }

      return {
        ok: true,
        balanceUsdc: balanceEntry.balance || "0",
        balanceAtomic: toAtomic(balanceEntry.balance || "0"),
        pendingBatchUsdc: balanceEntry.pendingBatch || "0",
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Retry on timeout/abort, not on other errors
      if (attempt < maxRetries && (msg.includes("abort") || msg.includes("timeout") || msg.includes("fetch failed"))) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      return {
        ok: false,
        error: `Gateway balance check failed: ${msg}`,
      };
    }
  }

  // Should not reach here, but fail closed
  return { ok: false, error: "Gateway balance check failed after retries" };
}

/**
 * Verify a buyer wallet has sufficient Gateway balance for a payment.
 * Returns ok:true if balance >= required amount.
 * Returns ok:false with `insufficient_gateway_balance` reason if not.
 */
export async function verifySufficientBalance(
  depositor: string,
  requiredAmountUsdc: string
): Promise<{ ok: boolean; balanceUsdc?: string; error?: string }> {
  const balance = await checkGatewayBalance({ depositor });

  if (!balance.ok) {
    return { ok: false, error: balance.error };
  }

  const available = parseFloat(balance.balanceUsdc || "0");
  const required = parseFloat(requiredAmountUsdc);

  if (available < required) {
    return {
      ok: false,
      balanceUsdc: balance.balanceUsdc,
      error: `insufficient_gateway_balance: available ${balance.balanceUsdc} USDC, required ${requiredAmountUsdc} USDC`,
    };
  }

  return { ok: true, balanceUsdc: balance.balanceUsdc };
}

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Convert human-readable USDC to atomic (6 decimals).
 * e.g. "1.500000" → "1500000"
 */
function toAtomic(humanUsdc: string): string {
  const num = parseFloat(humanUsdc);
  if (isNaN(num)) return "0";
  return Math.round(num * 1_000_000).toString();
}
