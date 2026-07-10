/**
 * String-safe USDC decimal → atomic conversion.
 *
 * Avoids IEEE-754 float drift: "0.1" → 100000n, "0.000001" → 1n.
 * Used by both gateway-balance (pre-payment check) and buyer-transport
 * (amount validation) to ensure consistent BigInt comparison.
 */

/** Convert a USDC decimal string to atomic units (bigint, 6 decimals). */
export function usdcDecimalToAtomic(usdc: string): bigint {
  const trimmed = usdc.trim();
  if (!trimmed || !/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) {
    return BigInt(0);
  }
  const [whole, frac = ""] = trimmed.split(".");
  // Pad or truncate to 7 digits (6 + 1 for rounding)
  const extended = frac.padEnd(7, "0");
  const digits = extended.slice(0, 7);
  const d6 = BigInt(digits.slice(0, 6));
  const d7 = BigInt(digits[6] ?? "0");
  // Round: if 7th digit >= 5, round up 6th
  const rounded = d6 + (d7 >= BigInt(5) ? BigInt(1) : BigInt(0));
  return BigInt(whole) * BigInt(1_000_000) + rounded;
}
