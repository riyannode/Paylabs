/**
 * Email OTP utilities.
 *
 * OTP codes are SHA-256 hashed before storage — plaintext never hits the DB.
 */

import { createHash, randomInt } from "node:crypto";

const OTP_LENGTH = 6;
const _OTP_TTL_MS = 5 * 60 * 1000;        // 5 minutes
const MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX_CODES = 3;

/** Generate a 6-digit OTP code. */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(OTP_LENGTH, "0");
}

/** SHA-256 hex digest of the code. */
export function hashOtp(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export const OTP_TTL_MS = _OTP_TTL_MS;
export const OTP_MAX_ATTEMPTS = MAX_ATTEMPTS;
export const OTP_RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_MS;
export const OTP_RATE_LIMIT_MAX_CODES = RATE_LIMIT_MAX_CODES;
