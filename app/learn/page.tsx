import { supabaseAdmin } from "@/lib/supabase/server";
import { shortAddress, formatUsdc } from "@/lib/utils";

export const dynamic = "force-dynamic";

async function getLessons() {
  const { data } = await supabaseAdmin()
    .from("paylabs_lessons")
    .select("id, slug, title, summary, price_usdc, difficulty, tags, estimated_minutes, creator:paylabs_creators(display_name, wallet_address), source:paylabs_sources(source_title, canonical_url)")
    .eq("is_published", true)
    .order("price_usdc", { ascending: true });
  return data ?? [];
}

export default async function LearnPage() {
  const lessons = await getLessons();

  return (
    <div>
      <h1 style={{ fontSize: "2rem", fontWeight: 700, marginBottom: "0.5rem" }}>
        Lesson Catalog
      </h1>
      <p style={{ color: "var(--muted)", marginBottom: "2rem" }}>
        Source-backed micro-lessons. Each unlock requires a live x402 payment on Arc testnet.
      </p>

      <div style={{ display: "grid", gap: "1rem" }}>
        {lessons.map((l: any) => (
          <a
            key={l.id}
            href={`/learn/${l.slug}`}
            className="card"
            style={{ display: "block", textDecoration: "none", color: "inherit" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.5rem" }}>
              <h3 style={{ fontSize: "1.125rem", fontWeight: 600, margin: 0 }}>{l.title}</h3>
              <span style={{ fontWeight: 700, color: "var(--accent-green)", whiteSpace: "nowrap" }}>
                {formatUsdc(l.price_usdc)}
              </span>
            </div>
            <p style={{ color: "var(--muted)", fontSize: "0.875rem", margin: "0 0 0.75rem" }}>{l.summary}</p>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
              <span className={`badge badge-${l.difficulty}`}>{l.difficulty}</span>
              {l.tags?.slice(0, 3).map((t: string) => (
                <span key={t} style={{ fontSize: "0.75rem", color: "var(--muted)" }}>#{t}</span>
              ))}
              <span style={{ fontSize: "0.75rem", color: "var(--muted)", marginLeft: "auto" }}>
                {l.estimated_minutes}min | {l.source?.source_title}
              </span>
            </div>
            {l.creator && (
              <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "0.5rem" }}>
                Creator: {l.creator.display_name} ({shortAddress(l.creator.wallet_address)})
              </div>
            )}
          </a>
        ))}
      </div>
    </div>
  );
}
