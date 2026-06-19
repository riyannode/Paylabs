import { supabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

async function safeCount(
  table: string,
  filter?: (q: any) => any
): Promise<number> {
  try {
    let q: any = supabaseAdmin().from(table).select("id", { count: "exact", head: true });
    if (filter) q = filter(q);
    const { count, error } = await q;
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

async function getCounts() {
  const [routes, feedItems, sourcePayments, agentPayments] = await Promise.all([
    safeCount("paylabs_rsshub_routes", (q) => q.eq("is_active", true)),
    safeCount("paylabs_feed_items", (q) => q.eq("is_active", true)),
    safeCount("paylabs_source_payments", (q) => q.eq("status", "completed")),
    safeCount("paylabs_agent_payments", (q) => q.eq("status", "completed")),
  ]);
  return { routes, feedItems, sourcePayments, agentPayments };
}

const FLOW_STEPS = [
  { num: "1", label: "RSSHub Sync", desc: "Import content from RSSHub routes into feed items" },
  { num: "2", label: "AI Source Path", desc: "AI picks source-backed feed items for your goal" },
  { num: "3", label: "Review & Approve", desc: "Review the proposed source path and approve" },
  { num: "4", label: "Pay & Cite", desc: "Pay per source citation, creator gets paid" },
];

export default async function LandingPage() {
  const counts = await getCounts();

  return (
    <div style={{ display: "grid", gap: 48 }}>
      {/* Hero */}
      <section style={{ textAlign: "center", paddingTop: 48 }}>
        <h1
          style={{
            fontSize: 44,
            fontWeight: 800,
            letterSpacing: "-0.04em",
            lineHeight: 1.1,
            margin: "0 0 12px",
          }}
        >
          RSSHub source paths
          <br />
          with x402 payments.
        </h1>
        <p
          className="muted"
          style={{
            fontSize: 17,
            maxWidth: 480,
            margin: "0 auto 28px",
            lineHeight: 1.5,
          }}
        >
          Discover sources via RSSHub, build AI source paths, pay per citation.
        </p>
        <div style={{ display: "flex", justifyContent: "center", gap: 12 }}>
          <a href="/tutor" className="btn btn-primary" style={{ height: 44, padding: "0 24px", fontSize: 15 }}>
            Start Tutor
          </a>
          <a href="/dashboard" className="btn btn-secondary" style={{ height: 44, padding: "0 24px", fontSize: 15 }}>
            View Dashboard
          </a>
        </div>
      </section>

      {/* Live stats */}
      <section>
        <div className="grid-4">
          {[
            { label: "RSSHub Routes", value: counts.routes },
            { label: "Feed Items", value: counts.feedItems },
            { label: "Source Payments", value: counts.sourcePayments },
            { label: "Agent Payments", value: counts.agentPayments },
          ].map((stat) => (
            <div className="card" key={stat.label} style={{ textAlign: "center" }}>
              <div className="muted" style={{ fontSize: 13 }}>{stat.label}</div>
              <div className="kpi" style={{ marginTop: 4 }}>{stat.value}</div>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section style={{ maxWidth: 640, margin: "0 auto" }}>
        <h2 className="section-title" style={{ textAlign: "center", marginBottom: 20 }}>How it works</h2>
        <div style={{ display: "grid", gap: 12 }}>
          {FLOW_STEPS.map((step) => (
            <div
              key={step.num}
              className="card-soft"
              style={{ display: "flex", alignItems: "center", gap: 16 }}
            >
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "50%",
                  background: "var(--foreground)",
                  color: "white",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  fontSize: 14,
                  flexShrink: 0,
                }}
              >
                {step.num}
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{step.label}</div>
                <div className="muted" style={{ fontSize: 13 }}>{step.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
