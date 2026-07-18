import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const PUBLIC_API_VERSION = "2026-07-18";
export const SERVER_MAX_BUDGET_USDC = "1.000000";
export const DEFAULT_BUDGET_USDC = "0.010000";
export const PUBLIC_RESEARCH_PATH = "/api/x402/v1/research";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function createReadToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256Hex(token) };
}

export function constantTimeEqualHex(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(v) ? v : null;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function parseUsdc(value: unknown, fallback: string): string | null {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = typeof value === "number" ? value.toString() : String(value).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) return null;
  const [whole, frac = ""] = raw.split(".");
  const normalized = `${whole}.${frac.padEnd(6, "0")}`;
  const atomic = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
  if (atomic <= 0n) return null;
  return normalized;
}

export function usdcToAtomic(usdc: string): bigint {
  const [whole, frac = ""] = usdc.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6));
}
