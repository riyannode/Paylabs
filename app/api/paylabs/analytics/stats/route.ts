import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { getVisitorStats } from "@/lib/paylabs/analytics/visitor-stats";

export const dynamic = "force-dynamic";

async function safeQuery<T>(
  fn: () => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> {
  try {
    const { data, error } = await fn();
    if (error) return [];
    return data ?? [];
  } catch {
    return [];
  }
}

function uniqueWalletCount(rows: { user_wallet?: string | null }[]): number {
  return new Set(
    rows.map((r) => r.user_wallet?.toLowerCase()).filter(Boolean)
  ).size;
}

export async function GET() {
  try {
    const now = Date.now();
    const [userRowsAll, userRows24h, userRows7d] = await Promise.all([
      safeQuery<{ user_wallet: string | null }>(() =>
        supabaseAdmin()
          .from("paylabs_discovery_runs")
          .select("user_wallet")
          .limit(5000)
      ),
      safeQuery<{ user_wallet: string | null }>(() =>
        supabaseAdmin()
          .from("paylabs_discovery_runs")
          .select("user_wallet")
          .gte("created_at", new Date(now - 86400000).toISOString())
          .limit(5000)
      ),
      safeQuery<{ user_wallet: string | null }>(() =>
        supabaseAdmin()
          .from("paylabs_discovery_runs")
          .select("user_wallet")
          .gte("created_at", new Date(now - 7 * 86400000).toISOString())
          .limit(5000)
      ),
    ]);

    const visitorStats = await getVisitorStats();

    return NextResponse.json({
      uniqueUsers: uniqueWalletCount(userRowsAll) + visitorStats.uniqueVisitors,
      active24h: uniqueWalletCount(userRows24h) + visitorStats.visitors24h,
      active7d: uniqueWalletCount(userRows7d) + visitorStats.visitors7d,
    });
  } catch {
    return NextResponse.json({ uniqueUsers: 0, active24h: 0, active7d: 0 });
  }
}
