import crypto from "node:crypto";
import {
  createPublicClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { arcTestnet } from "viem/chains";
import { config } from "../config.js";
import sql from "../db/client.js";

// --- SIWE parsing (EIP-4361) ---

interface ParsedSiwe {
  address: Address;
  domain: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
  statement?: string;
}

const SIWE_REGEX =
  /^(?<domain>[^\s]+) wants you to sign in with your Ethereum account:\n(?<address>0x[0-9a-fA-F]{40})\n\n(?:(?<statement>[^\n]*)\n\n)?URI: (?<uri>[^\n]+)\nVersion: (?<version>\d+)\nChain ID: (?<chainId>\d+)\nNonce: (?<nonce>[^\n]+)\nIssued At: (?<issuedAt>[^\n]+)(?:\nExpiration Time: (?<expirationTime>[^\n]+))?(?:\nNot Before: (?<notBefore>[^\n]+))?(?:\nRequest ID: (?<requestId>[^\n]+))?(?:\nResources:(?<resources>(?:\n- [^\n]+)*))?$/;

function parseSiweMessage(message: string): ParsedSiwe | null {
  const match = message.match(SIWE_REGEX);
  if (!match?.groups) return null;
  return {
    address: match.groups.address as Address,
    domain: match.groups.domain,
    uri: match.groups.uri,
    version: match.groups.version,
    chainId: Number(match.groups.chainId),
    nonce: match.groups.nonce,
    issuedAt: match.groups.issuedAt,
    expirationTime: match.groups.expirationTime,
    notBefore: match.groups.notBefore,
    statement: match.groups.statement,
  };
}

// --- Nonce ---

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function generateNonce(walletAddress: string): Promise<{
  nonce: string;
  message: string;
  expiresAt: string;
}> {
  // Validate wallet address format
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
    throw new AuthError("Invalid wallet address", 400);
  }

  const nonce = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS);

  await sql`
    INSERT INTO paylabs_auth_nonces (wallet_address, nonce, used, expires_at)
    VALUES (${walletAddress.toLowerCase()}, ${nonce}, false, ${expiresAt.toISOString()})
  `;

  // Build the final SIWE message with the real address — no placeholder
  const domain = new URL(config.publicOrigin).host;
  const message = `${domain} wants you to sign in with your Ethereum account:
${walletAddress}

Sign in to Paylabs

URI: ${config.publicOrigin}
Version: 1
Chain ID: ${config.arcChainId}
Nonce: ${nonce}
Issued At: ${new Date().toISOString()}`;

  return { nonce, message, expiresAt: expiresAt.toISOString() };
}

// --- Verify ---

const client = createPublicClient({
  chain: arcTestnet,
  transport: http(config.arcRpcUrl),
});

export async function verifySiwe(params: {
  message: string;
  signature: Hex;
}): Promise<{ userId: string; walletAddress: string }> {
  const { message, signature } = params;

  // 1. Parse SIWE message
  const parsed = parseSiweMessage(message);
  if (!parsed) {
    throw new AuthError("Invalid SIWE message format", 400);
  }

  // 2. Validate domain
  const expectedDomain = new URL(config.publicOrigin).host;
  if (parsed.domain !== expectedDomain) {
    throw new AuthError(
      `Domain mismatch: expected ${expectedDomain}, got ${parsed.domain}`,
      400
    );
  }

  // 3. Validate chainId
  if (parsed.chainId !== config.arcChainId) {
    throw new AuthError(
      `Chain ID mismatch: expected ${config.arcChainId}, got ${parsed.chainId}`,
      400
    );
  }

  // 4. Check nonce exists, not used, not expired
  const nonceRows = await sql`
    SELECT id, wallet_address, used, expires_at
    FROM paylabs_auth_nonces
    WHERE nonce = ${parsed.nonce}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (nonceRows.length === 0) {
    throw new AuthError("Nonce not found", 401);
  }

  const nonceRow = nonceRows[0];

  if (nonceRow.used) {
    throw new AuthError("Nonce already used", 401);
  }

  if (new Date(nonceRow.expires_at) < new Date()) {
    throw new AuthError("Nonce expired", 401);
  }

  // 5. Verify signature — recover address from the signed message
  const recoveredAddress = await client.verifySiweMessage({
    message,
    signature,
    domain: expectedDomain,
    nonce: parsed.nonce,
    address: parsed.address,
  });

  if (!recoveredAddress) {
    throw new AuthError("Invalid signature", 401);
  }

  // 6. Mark nonce as used and bind to wallet address
  await sql`
    UPDATE paylabs_auth_nonces
    SET used = true, wallet_address = ${parsed.address}
    WHERE id = ${nonceRow.id}
  `;

  // 7. Upsert user
  const walletAddress = parsed.address.toLowerCase();
  const users = await sql`
    INSERT INTO paylabs_users (wallet_address)
    VALUES (${walletAddress})
    ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = EXCLUDED.wallet_address
    RETURNING id, wallet_address
  `;

  const user = users[0];

  return {
    userId: user.id as string,
    walletAddress: user.wallet_address as string,
  };
}

// --- JWT ---

function base64url(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function parseDuration(str: string): number {
  const match = str.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 24 * 60 * 60; // default 24h
  const n = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return n * multipliers[unit];
}

export function signJwt(payload: {
  sub: string;
  walletAddress: string;
}): string {
  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    throw new AuthError("JWT_SECRET is not configured or too short (min 32 chars)", 500);
  }

  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const exp = now + parseDuration(config.jwtExpiresIn);

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(
    JSON.stringify({ ...payload, iat: now, exp })
  );
  const signingInput = `${headerB64}.${payloadB64}`;

  const sig = crypto
    .createHmac("sha256", config.jwtSecret)
    .update(signingInput)
    .digest();

  return `${signingInput}.${base64url(sig)}`;
}

export function verifyJwt(token: string): {
  sub: string;
  walletAddress: string;
} {
  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    throw new AuthError("JWT_SECRET is not configured or too short (min 32 chars)", 500);
  }

  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("Invalid JWT format", 401);

  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  const expectedSig = crypto
    .createHmac("sha256", config.jwtSecret)
    .update(signingInput)
    .digest();

  const expectedB64 = base64url(expectedSig);

  // Constant-time comparison
  if (
    sigB64.length !== expectedB64.length ||
    !crypto.timingSafeEqual(
      Buffer.from(sigB64, "utf-8"),
      Buffer.from(expectedB64, "utf-8")
    )
  ) {
    throw new AuthError("Invalid JWT signature", 401);
  }

  const payload = JSON.parse(
    Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()
  );

  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new AuthError("JWT expired", 401);
  }

  return { sub: payload.sub, walletAddress: payload.walletAddress };
}

// --- User lookup ---

export async function getUserById(id: string): Promise<{
  id: string;
  walletAddress: string;
  createdAt: Date;
} | null> {
  const rows = await sql`
    SELECT id, wallet_address, created_at
    FROM paylabs_users
    WHERE id = ${id}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return {
    id: rows[0].id as string,
    walletAddress: rows[0].wallet_address as string,
    createdAt: new Date(rows[0].created_at as string),
  };
}

// --- Error ---

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}
