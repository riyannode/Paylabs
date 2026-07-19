/**
 * Office-only monetary sanitizer.
 * Pure functions — no server dependencies. Safe for both server and client import.
 *
 * Purpose: ensure no PayLabsOfficeEvent.message reaching user-visible speech bubbles
 * contains monetary data. Applied at two defense layers:
 *   1. Emission boundary (server.ts) — new events
 *   2. Render boundary (PixelAgent.tsx) — historical Supabase events
 */

import type { OfficeEventType } from "./types";

/** Patterns that indicate monetary content in office bubble text. */
const MONETARY_PATTERNS: RegExp[] = [
  /\b\d[\d,.]*\s*USDC\b/i,           // "0.000001 USDC", "1.5 USDC"
  /\bUSDC\b/i,                         // standalone USDC
  /[\$€£¥₹]\s*\d/,                     // "$0.01", "€1.00"
  /\b\d+\.?\d*\s*(?:USD|EUR|GBP|BTC|ETH|DAI|USDT)\b/i, // other tokens
  /\b(?:cost|spend|budget|fee|balance|price|payout amount|reserve amount)\s*[:=]\s*\d/i,
  /\b(?:remaining|total|estimated)\s+(?:budget|spend|cost)\s*[:=]?\s*\d/i,
  /\b\d+\.?\d*\s*(?:tokens?|coins?|wei|gwei|lamports)\b/i,
];

/** Fallback messages keyed by office event type. */
const SAFE_FALLBACKS: Partial<Record<OfficeEventType, string>> = {
  "x402.settled": "x402 settlement completed",
  "x402.failed": "x402 settlement failed",
  "x402.requested": "x402 settlement requested",
  "creator.paid": "Creator payout completed",
  "treasury.retained": "Funds retained in treasury reserve",
  "agent.completed": "Service completed",
  "agent.failed": "Service failed",
  "run.completed": "Run completed",
  "run.failed": "Run failed",
};

function isMonetaryMessage(text: string): boolean {
  return MONETARY_PATTERNS.some((p) => p.test(text));
}

/**
 * Sanitize an office event message to remove all monetary content.
 * Only touches `message` — payment, metadata, title, and all backend fields are untouched.
 * Fail-closed: if message looks monetary or ambiguous, replace with safe operational fallback.
 */
export function sanitizeOfficeMessage(
  message: string | null | undefined,
  eventType: OfficeEventType,
): string | null {
  if (message == null) return null;
  if (!isMonetaryMessage(message)) return message;
  return SAFE_FALLBACKS[eventType] ?? "Service completed";
}

/**
 * Sanitize all office event fields that reach user-visible speech bubbles.
 * Used at the emission boundary (server.ts) and the render boundary (PixelAgent.tsx).
 */
export function sanitizeOfficeEvent<T extends { message?: string | null; type: OfficeEventType }>(
  event: T,
): T {
  if (event.message == null) return event;
  const clean = sanitizeOfficeMessage(event.message, event.type);
  if (clean === event.message) return event;
  return { ...event, message: clean };
}

/**
 * Sanitize a message string for display when the event type is unknown.
 * Used in render boundaries where only the message is available (e.g. historical events).
 * Fail-closed: replaces monetary text with a generic safe label.
 */
export function sanitizeDisplayMessage(message: string | null | undefined): string | null {
  if (message == null) return null;
  if (!isMonetaryMessage(message)) return message;
  return "Service completed";
}
