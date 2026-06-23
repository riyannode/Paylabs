import { supabaseAdmin } from "@/lib/supabase/server";
import { short, shortUrl, usdc } from "@/lib/utils";

/** Strip all HTML/XML tags — character scan, not regex */
function stripTags(html: string): string {
  let out = "";
  let inTag = false;
  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if (ch === "<") { inTag = true; continue; }
    if (ch === ">") { inTag = false; continue; }
    if (!inTag) out += ch;
  }
  return out.trim();
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

export default async function SourcesPage() {
  const items = await safeQuery<any>(() =>
    supabaseAdmin()
      .from("paylabs_feed_items")
      .select(
        "id, title, summary, canonical_url, author_name, publisher, published_at, creator_wallet, is_monetized, price_per_citation_usdc, price_per_unlock_usdc, normalized_sha256, is_active"
      )
      .eq("is_active", true)
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(200)
  );

  return (
    <div style={{ display: "grid", gap: 24 }}>
      <div>
        <a href="/" style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>← Chat</a>
        <h1 className="page-title">Sources</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          RSSHub feed items — source-backed content catalog.
        </p>
      </div>

      {items.length === 0 ? (
        <div className="card">
          <div className="muted" style={{ textAlign: "center", padding: 48 }}>
            No sources yet. Create RSSHub routes and run sync to import feed
            items.
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
            gap: 16,
          }}
        >
          {items.map((item: any) => (
            <div
              key={item.id}
              className="card"
              style={{ display: "flex", flexDirection: "column", gap: 8 }}
            >
              <div style={{ fontWeight: 700, fontSize: 15 }}>
                {item.title || "(untitled)"}
              </div>

              {item.summary && (
                <p
                  className="muted"
                  style={{
                    fontSize: 13,
                    lineHeight: 1.5,
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {stripTags(item.summary)}
                </p>
              )}

              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  fontSize: 11,
                  marginTop: "auto",
                }}
              >
                {item.author_name && (
                  <span className="badge">{item.author_name}</span>
                )}
                {item.publisher && item.publisher !== item.author_name && (
                  <span className="badge">{item.publisher}</span>
                )}
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                  fontSize: 12,
                  marginTop: 4,
                }}
              >
                <div>
                  <span className="muted">Citation</span>{" "}
                  <span className="data-mono">
                    {item.is_monetized ? usdc(item.price_per_citation_usdc) : "Not monetized"}
                  </span>
                </div>
                <div>
                  <span className="muted">Unlock</span>{" "}
                  <span className="data-mono">
                    {item.is_monetized ? usdc(item.price_per_unlock_usdc) : "—"}
                  </span>
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: 11,
                  marginTop: 4,
                }}
              >
                <a
                  href={item.canonical_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="muted"
                  style={{ textDecoration: "underline" }}
                >
                  {shortUrl(item.canonical_url, 35)}
                </a>
                <span className="badge" style={{ fontSize: 10 }}>
                  {item.is_monetized ? "Monetized" : "Sample"}
                </span>
              </div>

              <div style={{ fontSize: 11 }}>
                {item.normalized_sha256 ? (
                  <span className="badge badge-success">
                    hash: {short(item.normalized_sha256)}
                  </span>
                ) : (
                  <span className="badge badge-warning">no hash</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
