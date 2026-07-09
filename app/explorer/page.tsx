import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { short, usdc } from "@/lib/utils";
import { hrefFromTx } from "@/lib/paylabs/x402/payment-links";
import BatchResolverLink from "@/components/paylabs/BatchResolverLink";
import SubPageMobileNav from "@/components/paylabs/SubPageMobileNav";
import PaymentTable from "@/components/paylabs/PaymentTable";
import { getVisitorStats } from "@/lib/paylabs/analytics/visitor-stats";

const PAYMENT_SAFE_FIELDS = [
  "event_id",
  "discovery_run_id",
  "buyer",
  "seller",
  "node_type",
  "status",
  "amount_usdc",
  "tx_hash",
  "explorer_url",
  "batch_tx_hash",
  "batch_explorer_url",
  "error",
  "created_at",
].join(",");

async function getRecentX402Payments(limit = 50) {
  const { data } = await supabaseAdmin()
    .from("paylabs_service_payment_events")
    .select(PAYMENT_SAFE_FIELDS)
    .order("created_at", { ascending: false })
    .limit(limit);
  return data || [];
}

async function getLastTx() {
  const { data } = await supabaseAdmin()
    .from("paylabs_receipts")
    .select("last_batch_tx_hash, last_batch_explorer_url, created_at")
    .not("last_batch_tx_hash", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0] || null;
}

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

async function safeCount(
  table: string,
  filter?: (q: any) => any
): Promise<number> {
  try {
    let q: any = supabaseAdmin()
      .from(table)
      .select("*", { count: "exact", head: true });
    if (filter) q = filter(q);
    const { count, error } = await q;
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

async function safeSum(
  table: string,
  column: string,
  filter?: (q: any) => any
): Promise<number> {
  try {
    const rows = await safeQuery<any>(() => {
      let q: any = supabaseAdmin().from(table).select(column);
      if (filter) q = filter(q);
      return q.limit(1000);
    });
    return rows.reduce((sum: number, row: any) => sum + Number(row[column] || 0), 0);
  } catch {
    return 0;
  }
}
// ─── Payout Ledger ──────────────────────────────────────────

async function getCreatorPaidUsdc(): Promise<number> {
  const rows = await safeQuery<any>(() =>
    supabaseAdmin()
      .from("paylabs_payout_ledger")
      .select("amount_usdc")
      .eq("payout_type", "creator_share")
      .in("status", ["paid", "gateway_accepted"])
      .limit(1000)
  );
  return rows.reduce((s, r) => s + Number(r.amount_usdc || 0), 0);
}

async function getTreasuryUnallocatedUsdc(): Promise<number> {
  const unalloc = await safeQuery<any>(() =>
    supabaseAdmin()
      .from("paylabs_payout_ledger")
      .select("amount_usdc")
      .eq("payout_type", "unallocated_reserve")
      .eq("status", "skipped")
      .limit(1000)
  );
  const retained = await safeQuery<any>(() =>
    supabaseAdmin()
      .from("paylabs_payout_ledger")
      .select("amount_usdc")
      .eq("payout_type", "treasury_retained")
      .limit(1000)
  );
  return [...unalloc, ...retained].reduce(
    (s, r) => s + Number(r.amount_usdc || 0),
    0
  );
}

// ─── Preflight / Entry payments from discovery_runs ──────────

async function getRecentPreflightPayments(limit = 50) {
  const { data } = await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .select(
      "id, created_at, agent_trace, entry_payment_amount_usdc, entry_payment_status, entry_payment_tx_hash, entry_payment_explorer_url, entry_payment_batch_tx_hash, entry_payment_batch_explorer_url"
    )
    .not("entry_payment_amount_usdc", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  return data || [];
}

// ─── Normalized row type for unified table ───────────────────

type NormalizedPaymentRow = {
  id: string;
  created_at: string;
  buyer: string;
  seller: string;
  amount_usdc: number;
  status: string;
  tx_hash: string | null;
  explorer_url: string | null;
  batch_tx_hash: string | null;
  batch_explorer_url: string | null;
  error: string | null;
  source: "service" | "preflight" | "entry";
  discovery_run_id: string;
  node_type: string | null;
};

function normalizeServiceRows(rows: any[]): NormalizedPaymentRow[] {
  return rows.map((r) => ({
    id: r.event_id,
    created_at: r.created_at,
    buyer: r.buyer ?? "—",
    seller: r.seller ?? "—",
    amount_usdc: Number(r.amount_usdc) || 0,
    status: r.status ?? "—",
    tx_hash: r.tx_hash ?? null,
    explorer_url: r.explorer_url ?? null,
    batch_tx_hash: r.batch_tx_hash ?? null,
    batch_explorer_url: r.batch_explorer_url ?? null,
    error: r.error ?? null,
    source: "service" as const,
    discovery_run_id: r.discovery_run_id,
    node_type: r.node_type ?? null,
  }));
}

function normalizePreflightRows(rows: any[]): NormalizedPaymentRow[] {
  const result: NormalizedPaymentRow[] = [];
  for (const r of rows) {
    const trace = (r.agent_trace as Record<string, unknown>) || {};
    const preflight = trace.auto_tier_preflight as Record<string, unknown> | undefined;

    // Entry payment row
    if (r.entry_payment_amount_usdc != null) {
      result.push({
        id: `entry-${r.id}`,
        created_at: r.created_at,
        buyer: "User",
        seller: "Platform",
        amount_usdc: Number(r.entry_payment_amount_usdc) || 0,
        status: r.entry_payment_status ?? "—",
        tx_hash: r.entry_payment_tx_hash ?? null,
        explorer_url: r.entry_payment_explorer_url ?? null,
        batch_tx_hash: r.entry_payment_batch_tx_hash ?? null,
        batch_explorer_url: r.entry_payment_batch_explorer_url ?? null,
        error: null,
        source: "entry",
        discovery_run_id: r.id,
        node_type: null,
      });
    }

    // Preflight routing payment row
    if (preflight?.status === "locked") {
      const rp = preflight.routing_payment as Record<string, unknown> | undefined;
      if (rp && Number(rp.amount_usdc) > 0) {
        result.push({
          id: `preflight-${r.id}`,
          created_at: r.created_at,
          buyer: "User",
          seller: "Platform",
          amount_usdc: Number(rp.amount_usdc) || 0,
          status: (rp.status as string) ?? "—",
          tx_hash: (rp.tx_hash as string) ?? null,
          explorer_url: (rp.explorer_url as string) ?? null,
          batch_tx_hash: (rp.batch_tx_hash as string) ?? null,
          batch_explorer_url: (rp.batch_explorer_url as string) ?? null,
          error: null,
          source: "preflight",
          discovery_run_id: r.id,
          node_type: null,
        });
      }
    }
  }
  return result;
}

// ─── Public label mapping ────────────────────────────────────

function labelNode(name: string | null | undefined): string {
  if (!name) return "—";
  if (name === "run_budget_controller") return "User";
  if (name === "user") return "User";
  if (name === "brain") return "Brain";
  if (name === "discovery_planner") return "Discovery Planner";
  if (name === "payment_decision") return "Payment Decision";
  if (name === "settlement_memory") return "Settlement Memory";
  if (name === "rsshub_live") return "RSSHub Live";
  if (name === "serpapi") return "SerpAPI";
  return name.split("_").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

function actorKindLabel(
  name: string | null | undefined,
  row: NormalizedPaymentRow,
  side: "buyer" | "seller"
): string {
  if (!name) return "";
  const raw = String(name);
  if (
    raw === "User" ||
    raw === "user" ||
    raw === "run_budget_controller" ||
    raw === "Platform" ||
    raw === "brain"
  ) {
    return "";
  }
  const macroNodes = new Set([
    "discovery_planner",
    "payment_decision",
    "settlement_memory",
  ]);
  if (macroNodes.has(raw)) return "Node";
  if (side === "seller" && row.node_type === "service") return "Child";
  return "";
}

function arrowFlowLabel(row: NormalizedPaymentRow): string {
  if (row.source === "preflight") return "Route Check";
  if (row.source === "entry") return "AI Run Payment";
  return "";
}

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

export default async function DashboardPage() {
  const [
    x402PaymentRows,
    preflightRows,
    servicePaymentCount,
    receiptCount,
    lastTxRow,
    totalSettledUsdc,
    // Payout ledger
    creatorPaidUsdc,
    treasuryUnallocatedUsdc,
  ] = await Promise.all([
    // x402 Service Payments
    getRecentX402Payments(25),
    // Preflight / Entry payments
    getRecentPreflightPayments(25),
    // Counts
    safeCount("paylabs_service_payment_events"),
    safeCount("paylabs_receipts"),
    // Last TX
    getLastTx(),
    // Total settled USDC
    safeSum("paylabs_receipts", "actual_settled_usdc"),
    // Payout ledger aggregations
    getCreatorPaidUsdc(),
    getTreasuryUnallocatedUsdc(),
  ]);

  // ─── Normalize and merge all payment rows ───
  const allRows: NormalizedPaymentRow[] = [
    ...normalizeServiceRows(x402PaymentRows),
    ...normalizePreflightRows(preflightRows),
  ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  // ─── User stats (unique wallets) ───
  const [
    existingTotalUsers,
    existingRecentUsers7d,
    existingRecentUsers24h,

  ] = await Promise.all([
    safeQuery<{ user_wallet: string }>(() =>
      supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("user_wallet")
        .limit(10000)
    ).then((rows) => new Set(rows.map((r) => r.user_wallet?.toLowerCase()).filter(Boolean)).size),
    safeQuery<{ user_wallet: string }>(() =>
      supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("user_wallet")
        .gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString())
        .limit(10000)
    ).then((rows) => new Set(rows.map((r) => r.user_wallet?.toLowerCase()).filter(Boolean)).size),
    safeQuery<{ user_wallet: string }>(() =>
      supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("user_wallet")
        .gte("created_at", new Date(Date.now() - 86400000).toISOString())
        .limit(10000)
    ).then((rows) => new Set(rows.map((r) => r.user_wallet?.toLowerCase()).filter(Boolean)).size),
  ]);

  // Add real visitor counts on top of existing wallet-based counts
  const visitorStats = await getVisitorStats();

  const totalUsers = existingTotalUsers + visitorStats.uniqueVisitors;
  const recentUsers7d = existingRecentUsers7d + visitorStats.visitors7d;
  const recentUsers24h = existingRecentUsers24h + visitorStats.visitors24h;

  return (
    <>
      <SubPageMobileNav />
    <div style={{ display: "grid", gap: 24 }}>
      <div>
        <a href="/chat" className="pl-back-btn">← Back to Chat</a>
        <h1 className="page-title">Explorer</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          Transaction activity
        </p>
      </div>

      {/* ─── KPI Cards ──────────────────────────────────────── */}
      <div className="grid-4">
        {[
          { label: "Unique Users", value: totalUsers },
          { label: "Users (24h)", value: recentUsers24h },
          { label: "Users (7d)", value: recentUsers7d },
          { label: "x402 Service Payments", value: servicePaymentCount },
          { label: "Receipts", value: receiptCount },
          { label: "Platform x402 Volume", value: usdc(totalSettledUsdc + creatorPaidUsdc) },
          {
            label: "Last TX",
            value: (() => {
              const hash = lastTxRow?.last_batch_tx_hash as string | null;
              const href = hrefFromTx(lastTxRow?.last_batch_explorer_url, hash);
              return href && hash ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--success, #22c55e)", textDecoration: "none", fontWeight: 600 }}
                >
                  {short(hash)} ↗
                </a>
              ) : (
                <span style={{ color: "var(--muted, #888)" }}>Check tx</span>
              );
            })(),
          },
          // Payout ledger KPIs
          { label: "Paid to Creators", value: usdc(creatorPaidUsdc) },
          { label: "Treasury / Unallocated", value: usdc(treasuryUnallocatedUsdc) },
        ].map((kpi) => (
          <div className="card" key={kpi.label}>
            <div className="muted" style={{ fontSize: 13 }}>
              {kpi.label}
            </div>
            <div className="kpi" style={{ marginTop: 4 }}>
              {kpi.value}
            </div>
          </div>
        ))}
      </div>



      {/* ─── x402 Service Payments Table ───────────────────── */}
      <section className="card">
        <h2 className="section-title">x402 Service Payments</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 16, padding: "8px 12px", borderLeft: "3px solid var(--accent, #6366f1)", background: "var(--accent-bg, rgba(99,102,241,0.06))" }}>
          Track x402 paid service calls from PayLabs runs. Batch link explorers are available in Payment Visibility after settlement.
        </p>
        {allRows.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>
            No x402 service payments yet.
          </div>
        ) : (
          <PaymentTable rows={allRows} />
        )}
      </section>

    </div>
    </>
  );
}
