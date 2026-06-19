import { supabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

async function getCounts() {
  const [lessons, unlocks, receipts] = await Promise.all([
    supabaseAdmin().from("paylabs_lessons").select("id", { count: "exact", head: true }).eq("is_published", true),
    supabaseAdmin().from("paylabs_unlocks").select("id", { count: "exact", head: true }),
    supabaseAdmin().from("paylabs_payout_receipts").select("id", { count: "exact", head: true }),
  ]);
  return {
    lessons: lessons.count ?? 0,
    payments: unlocks.count ?? 0,
    payouts: receipts.count ?? 0,
  };
}

export default async function LandingPage() {
  const counts = await getCounts();

  return (
    <div style={{ textAlign: "center", paddingTop: "3rem" }}>
      <h1 style={{ fontSize: "3rem", fontWeight: 800, marginBottom: "0.5rem" }}>
        Pay only for what you learn.
      </h1>
      <p style={{ color: "var(--muted)", fontSize: "1.125rem", marginBottom: "2rem", maxWidth: 600, marginLeft: "auto", marginRight: "auto" }}>
        PayLabs is an AI micro-learning buyer. Set your goal and budget.
        The AI Tutor picks source-backed lessons and pays via x402 on Arc testnet.
        Creators receive receipt-backed payouts.
      </p>

      <div style={{ display: "flex", justifyContent: "center", gap: "2rem", marginBottom: "3rem" }}>
        <div className="card" style={{ textAlign: "center", minWidth: 120 }}>
          <div style={{ fontSize: "2rem", fontWeight: 700 }}>{counts.lessons}</div>
          <div style={{ color: "var(--muted)", fontSize: "0.875rem" }}>Lessons</div>
        </div>
        <div className="card" style={{ textAlign: "center", minWidth: 120 }}>
          <div style={{ fontSize: "2rem", fontWeight: 700 }}>{counts.payments}</div>
          <div style={{ color: "var(--muted)", fontSize: "0.875rem" }}>Payments</div>
        </div>
        <div className="card" style={{ textAlign: "center", minWidth: 120 }}>
          <div style={{ fontSize: "2rem", fontWeight: 700 }}>{counts.payouts}</div>
          <div style={{ color: "var(--muted)", fontSize: "0.875rem" }}>Creator Payouts</div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "center", gap: "1rem" }}>
        <a href="/tutor" className="btn btn-primary" style={{ fontSize: "1rem", padding: "0.75rem 1.5rem" }}>
          Start with AI Tutor
        </a>
        <a href="/learn" className="btn btn-secondary" style={{ fontSize: "1rem", padding: "0.75rem 1.5rem" }}>
          Browse Lessons
        </a>
      </div>

      <div style={{ marginTop: "4rem", textAlign: "left", maxWidth: 600, marginLeft: "auto", marginRight: "auto" }}>
        <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "1rem" }}>How it works</h2>
        <ol style={{ color: "var(--muted)", lineHeight: 2 }}>
          <li>You set a learning goal and USDC budget</li>
          <li>AI Tutor proposes a path from real source-backed lessons</li>
          <li>You approve the path and budget policy</li>
          <li>Each lesson unlock is a live x402 payment on Arc testnet</li>
          <li>Creator receives a receipt-backed payout record</li>
        </ol>
      </div>
    </div>
  );
}
