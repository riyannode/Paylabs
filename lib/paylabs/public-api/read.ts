import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { constantTimeEqualHex, sha256Hex } from "./security";

export async function loadAuthorizedPublicRun(runId: string, token: string | null) {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return null;
  const { data } = await supabaseAdmin().from("paylabs_discovery_runs").select("*").eq("id", runId).not("public_api_version", "is", null).single();
  const run = data as Record<string, unknown> | null;
  if (!run) return null;
  const expected = typeof run.read_token_hash === "string" ? run.read_token_hash : null;
  if (!constantTimeEqualHex(expected, token ? sha256Hex(token) : null)) return false;
  return run;
}
