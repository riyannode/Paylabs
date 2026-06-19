import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function formatUsdc(amount: number): string {
  if (amount < 0.001) return `${(amount * 1_000_000).toFixed(0)} micro-USDC`;
  return `${amount.toFixed(4)} USDC`;
}

/** Shorten any hash/id/payment ref for display */
export function short(value?: string | null): string {
  if (!value) return "—";
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

/** Format USDC amount with 6 decimals */
export function usdc(value?: number | string | null): string {
  const n = Number(value || 0);
  return `${n.toFixed(6)} USDC`;
}

/** Safe Supabase query — returns empty array on error. Accepts any thenable. */
export async function safeQuery<T>(
  fn: () => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> {
  try {
    const { data, error } = await fn();
    if (error) return [];
    return data ?? [];
  } catch {
    return [];
  }
}
