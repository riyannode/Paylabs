import { supabaseAdmin } from "@/lib/paylabs/db/server";

type VisitorStats = {
  uniqueVisitors: number;
  visitors24h: number;
  visitors7d: number;
};

/**
 * Returns real visitor counts via the paylabs_visitor_stats() RPC.
 * DB-side COUNT(DISTINCT visitor_hash) — no JS dedup, no LIMIT cap.
 * Fail-safe: returns zeros if table/function is missing or errors.
 */
export async function getVisitorStats(): Promise<VisitorStats> {
  try {
    const { data, error } = await supabaseAdmin().rpc("paylabs_visitor_stats").single();
    if (error || !data) return { uniqueVisitors: 0, visitors24h: 0, visitors7d: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = data as any;
    return {
      uniqueVisitors: Number(row?.unique_visitors) || 0,
      visitors24h: Number(row?.visitors_24h) || 0,
      visitors7d: Number(row?.visitors_7d) || 0,
    };
  } catch {
    return { uniqueVisitors: 0, visitors24h: 0, visitors7d: 0 };
  }
}
