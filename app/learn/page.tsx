import { supabaseAdmin } from "@/lib/supabase/server";
import { shortAddress, formatUsdc } from "@/lib/utils";

export const dynamic = "force-dynamic";

async function getLessons() {
  const { data } = await supabaseAdmin()
    .from("paylabs_lessons")
    .select(
      "id, slug, title, price_usdc, difficulty, creator:paylabs_creators(display_name, wallet_address), source:paylabs_sources(source_title)"
    )
    .eq("is_published", true)
    .order("price_usdc", { ascending: true });
  return data ?? [];
}

export default async function LearnPage() {
  const lessons = await getLessons();

  return (
    <div style={{ display: "grid", gap: 24 }}>
      <div>
        <h1 className="page-title">Lessons</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          Source-backed micro-lessons. Each unlock is a live x402 payment.
        </p>
      </div>

      {lessons.length === 0 ? (
        <div className="card" style={{ textAlign: "center", color: "var(--muted)", padding: 32 }}>
          No published lessons yet.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {lessons.map((l: any) => (
            <a
              key={l.id}
              href={`/learn/${l.slug}`}
              className="card"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 12,
                alignItems: "center",
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{l.title}</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span className={`badge badge-${l.difficulty}`}>{l.difficulty}</span>
                  {l.creator && (
                    <span className="muted" style={{ fontSize: 12 }}>
                      {l.creator.display_name}
                    </span>
                  )}
                  {l.source?.source_title && (
                    <span className="muted" style={{ fontSize: 12 }}>
                      · {l.source.source_title}
                    </span>
                  )}
                </div>
              </div>
              <div style={{ fontWeight: 700, color: "var(--success)", whiteSpace: "nowrap", fontSize: 15 }}>
                {formatUsdc(l.price_usdc)}
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
