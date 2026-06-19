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
