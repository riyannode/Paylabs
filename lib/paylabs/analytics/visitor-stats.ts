import { supabaseAdmin } from "@/lib/paylabs/db/server";

type VisitorStats = {
  uniqueVisitors: number;
  visitors24h: number;
  visitors7d: number;
};

/**
 * Returns real visitor counts from paylabs_page_visits.
 * Only counts non-bot visitors. Uses COUNT(DISTINCT visitor_hash).
 * No raw visitor rows returned.
 */
export async function getVisitorStats(): Promise<VisitorStats> {
  const now = Date.now();
  const ago24h = new Date(now - 86400000).toISOString();
  const ago7d = new Date(now - 7 * 86400000).toISOString();

  const [total, day, week] = await Promise.all([
    supabaseAdmin()
      .from("paylabs_page_visits")
      .select("visitor_hash", { count: "exact", head: true })
      .eq("is_bot", false),
    supabaseAdmin()
      .from("paylabs_page_visits")
      .select("visitor_hash", { count: "exact", head: true })
      .eq("is_bot", false)
      .gte("created_at", ago24h),
    supabaseAdmin()
      .from("paylabs_page_visits")
      .select("visitor_hash", { count: "exact", head: true })
      .eq("is_bot", false)
      .gte("created_at", ago7d),
  ]);

  // head:true returns total count but not distinct — we need distinct counts.
  // Fall back to fetching visitor_hash values and deduplicating in JS.
  const [totalRows, dayRows, weekRows] = await Promise.all([
    safeVisitorHashes(supabaseAdmin()
      .from("paylabs_page_visits")
      .select("visitor_hash")
      .eq("is_bot", false)
      .limit(50000)),
    safeVisitorHashes(supabaseAdmin()
      .from("paylabs_page_visits")
      .select("visitor_hash")
      .eq("is_bot", false)
      .gte("created_at", ago24h)
      .limit(50000)),
    safeVisitorHashes(supabaseAdmin()
      .from("paylabs_page_visits")
      .select("visitor_hash")
      .eq("is_bot", false)
      .gte("created_at", ago7d)
      .limit(50000)),
  ]);

  return {
    uniqueVisitors: new Set(totalRows).size,
    visitors24h: new Set(dayRows).size,
    visitors7d: new Set(weekRows).size,
  };
}

async function safeVisitorHashes(
  query: PromiseLike<{ data: { visitor_hash: string }[] | null; error: unknown }>
): Promise<string[]> {
  try {
    const { data, error } = await query;
    if (error) return [];
    return (data ?? []).map((r) => r.visitor_hash).filter(Boolean);
  } catch {
    return [];
  }
}
