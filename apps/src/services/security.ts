// Security service
// JWT verification, request validation

import { config } from "../config.js";

export function validateOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (origin.startsWith("chrome-extension://")) return true;
  if (origin === "https://community.arc.io") return true;
  if (origin === "https://community.arc.network") return true;
  if (origin === "https://sepiasearch.org") return true;
  if (origin === config.publicOrigin) return true;
  return false;
}

export function sanitizeWalletAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error("Invalid wallet address format");
  }
  return address.toLowerCase();
}
