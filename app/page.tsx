import { supabaseAdmin } from "@/lib/supabase/server";
import PayLabsChatClient from "./paylabs-chat-client";

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

export default async function Page() {
  const now = Date.now();

  const [
    recentRuns,
    recentPayments,
    recentFeedItems,
    userRowsAll,
    userRows24h,
    userRows7d,
  ] = await Promise.all([
    // Recent discovery runs (for explorer sidebar)
    safeQuery<{
      id: string;
      user_wallet: string | null;
      route_tier: string | null;
      status: string | null;
      created_at: string | null;
    }>(() =>
      supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("id,user_wallet,route_tier,status,created_at")
        .order("created_at", { ascending: false })
        .limit(8)
    ),

    // Recent service payments (for paid edges count)
    safeQuery<{ discovery_run_id: string | null }>(() =>
      supabaseAdmin()
        .from("paylabs_service_payment_events")
        .select("discovery_run_id")
        .order("created_at", { ascending: false })
        .limit(50)
    ),

    // Recent active feed items
    safeQuery<{
      id: string;
      title: string | null;
      publisher: string | null;
      author_name: string | null;
      canonical_url: string | null;
      is_monetized: boolean | null;
    }>(() =>
      supabaseAdmin()
        .from("paylabs_feed_items")
        .select("id,title,publisher,author_name,canonical_url,is_monetized")
        .eq("is_active", true)
        .order("published_at", { ascending: false, nullsFirst: false })
        .limit(5)
    ),

    // All user wallets (for unique count)
    safeQuery<{ user_wallet: string | null }>(() =>
      supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("user_wallet")
        .limit(10000)
    ),

    // 24h user wallets
    safeQuery<{ user_wallet: string | null }>(() =>
      supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("user_wallet")
        .gte("created_at", new Date(now - 86400000).toISOString())
        .limit(10000)
    ),

    // 7d user wallets
    safeQuery<{ user_wallet: string | null }>(() =>
      supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("user_wallet")
        .gte("created_at", new Date(now - 7 * 86400000).toISOString())
        .limit(10000)
    ),
  ]);

  // Count paid edges per run
  const edgesByRun = new Map<string, number>();
  for (const p of recentPayments) {
    const id = p.discovery_run_id;
    if (!id) continue;
    edgesByRun.set(id, (edgesByRun.get(id) ?? 0) + 1);
  }

  // Find top wallet
  const walletRunCounts = new Map<string, number>();
  for (const r of userRowsAll) {
    const w = r.user_wallet?.toLowerCase();
    if (!w) continue;
    walletRunCounts.set(w, (walletRunCounts.get(w) ?? 0) + 1);
  }
  let topWallet: { address: string; runs: number } | null = null;
  for (const [address, runs] of walletRunCounts) {
    if (!topWallet || runs > topWallet.runs) {
      topWallet = { address, runs };
    }
  }

  const explorerRuns = recentRuns.map((run) => ({
    ...run,
    paid_edges: edgesByRun.get(run.id) ?? 0,
  }));

  const analytics = {
    uniqueUsers: uniqueWalletCount(userRowsAll),
    active24h: uniqueWalletCount(userRows24h),
    active7d: uniqueWalletCount(userRows7d),
    topWallet,
  };

  return (
    <PayLabsChatClient
      analytics={analytics}
      explorerRuns={explorerRuns}
      feedItems={recentFeedItems}
    />
  );
}
