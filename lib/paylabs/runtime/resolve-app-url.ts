/**
 * Shared URL resolver for PayLabs serverless self-calls.
 *
 * Priority:
 *   1. PAYLABS_INTERNAL_APP_URL (explicit override for self-calls)
 *   2. VERCEL_URL (auto-set by Vercel at runtime)
 *   3. NEXT_PUBLIC_APP_URL
 *   4. PAYLABS_APP_URL
 *
 * Returns { baseUrl, source, hostname } where:
 *   - baseUrl: normalized https://... string (no trailing slash)
 *   - source: which env var was used (safe label, no value)
 *   - hostname: parsed hostname (safe for logging)
 */

export function resolvePaylabsAppUrl(): {
  baseUrl: string;
  source: string;
  hostname: string;
} {
  const raw =
    process.env.PAYLABS_INTERNAL_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.PAYLABS_APP_URL ||
    "";

  if (!raw) {
    throw new Error(
      "config_error: No PAYLABS_INTERNAL_APP_URL, VERCEL_URL, NEXT_PUBLIC_APP_URL, or PAYLABS_APP_URL"
    );
  }

  // Determine source label (safe — no env value exposed)
  let source = "unknown";
  if (process.env.PAYLABS_INTERNAL_APP_URL) source = "PAYLABS_INTERNAL_APP_URL";
  else if (process.env.VERCEL_URL) source = "VERCEL_URL";
  else if (process.env.NEXT_PUBLIC_APP_URL) source = "NEXT_PUBLIC_APP_URL";
  else if (process.env.PAYLABS_APP_URL) source = "PAYLABS_APP_URL";

  // Normalize: add https:// if missing, strip trailing slash
  let base = raw.trim();
  if (!/^https?:\/\//.test(base)) base = `https://${base}`;
  base = base.replace(/\/+$/, "");

  // Validate: must parse as URL with non-empty hostname
  let hostname = "";
  try {
    const parsed = new URL(base);
    hostname = parsed.hostname;
    if (!hostname) throw new Error("empty hostname");
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`invalid protocol: ${parsed.protocol}`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`config_error: invalid resolved app URL: ${msg}`);
  }

  return { baseUrl: base, source, hostname };
}
