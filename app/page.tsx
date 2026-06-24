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

  const [userRowsAll, userRows24h, userRows7d] = await Promise.all([
    safeQuery<{ user_wallet: string | null }>(() =>
      supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("user_wallet")
        .limit(10000)
    ),
    safeQuery<{ user_wallet: string | null }>(() =>
      supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("user_wallet")
        .gte("created_at", new Date(now - 86400000).toISOString())
        .limit(10000)
    ),
    safeQuery<{ user_wallet: string | null }>(() =>
      supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("user_wallet")
        .gte("created_at", new Date(now - 7 * 86400000).toISOString())
        .limit(10000)
    ),
  ]);

  const analytics = {
    uniqueUsers: uniqueWalletCount(userRowsAll),
    active24h: uniqueWalletCount(userRows24h),
    active7d: uniqueWalletCount(userRows7d),
  };

  return <PayLabsChatClient analytics={analytics} />;
}
