import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { short, shortUrl, usdc } from "@/lib/utils";
import SubPageMobileNav from "@/components/paylabs/SubPageMobileNav";

export const dynamic = "force-dynamic";

type VerifiedCreatorClaim = {
  id: string;
  creator_name: string | null;
  source_url: string | null;
  canonical_url: string | null;
  source_domain: string | null;
  source_platform: string | null;
  claim_scope: string | null;
  claim_scope_key: string | null;
  verified_at: string | null;
};

type FeedItem = {
  id: string;
  title: string | null;
  summary: string | null;
  canonical_url: string;
  author_name: string | null;
  publisher: string | null;
  published_at: string | null;
  creator_wallet: string | null;
  is_monetized: boolean;
  price_per_citation_usdc: number | null;
  price_per_unlock_usdc: number | null;
  normalized_sha256: string | null;
  is_active: boolean;
};

type SourcePayment = {
  id: string;
  created_at: string;
  user_wallet: string | null;
  source_url: string | null;
  creator_wallet: string | null;
  amount_usdc: number | null;
  payment_kind: string | null;
  payment_id: string | null;
  status: string;
};

function stripTags(html: string): string {
  let output = "";
  let inTag = false;

  for (let index = 0; index < html.length; index += 1) {
    const character = html[index];

    if (character === "<") {
      inTag = true;
      continue;
    }

    if (character === ">") {
      inTag = false;
      continue;
    }

    if (!inTag) output += character;
  }

  return output.trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function cleanFeedText(input: unknown): string {
  const raw = typeof input === "string" ? input : "";

  if (!raw) return "";

  const decodedOnce = decodeEntities(raw);
  const decodedTwice = decodeEntities(decodedOnce);

  return stripTags(decodedTwice).replace(/\s+/g, " ").trim();
}

function timeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();

  if (Number.isNaN(date.getTime())) return "recently";

  const differenceMilliseconds = now.getTime() - date.getTime();
  const differenceMinutes = Math.floor(differenceMilliseconds / 60_000);

  if (differenceMinutes < 1) return "just now";
  if (differenceMinutes < 60) return `${differenceMinutes}m ago`;

  const differenceHours = Math.floor(differenceMinutes / 60);

  if (differenceHours < 24) return `${differenceHours}h ago`;

  const differenceDays = Math.floor(differenceHours / 24);

  if (differenceDays < 30) return `${differenceDays}d ago`;

  const differenceMonths = Math.floor(differenceDays / 30);

  return `${differenceMonths}mo ago`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function safeQuery<T>(
  fn: () => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  try {
    const { data, error } = await fn();
    if (error) return [];
    return data ?? [];
  } catch {
    return [];
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function claimScopeLabel(scope: string | null): string {
  if (scope === "github_repo") return "GitHub repository";
  if (scope === "platform_profile") return "Creator profile";
  if (scope === "domain") return "Domain";
  if (scope === "host") return "Hosted site";
  if (scope === "exact_url") return "Exact URL";

  return "Creator source";
}

function platformLabel(platform: string | null): string {
  if (platform === "github") return "GitHub";
  if (platform === "twitter") return "X";
  if (platform === "youtube") return "YouTube";
  if (platform === "medium") return "Medium";
  if (platform === "substack") return "Substack";
  if (platform === "vercel") return "Vercel";
  if (platform === "netlify") return "Netlify";
  if (platform === "github_pages") return "GitHub Pages";
  if (platform === "domain") return "Website";

  return "Source";
}

function getClaimUrl(claim: VerifiedCreatorClaim): string | null {
  return claim.source_url ?? claim.canonical_url ?? null;
}

function getClaimDisplayName(claim: VerifiedCreatorClaim): string {
  return (
    claim.creator_name?.trim() ||
    claim.source_domain?.trim() ||
    platformLabel(claim.source_platform)
  );
}

function getInitial(value: string): string {
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed[0].toUpperCase() : "C";
}

const creatorAvatarPalettes = [
  {
    background: "linear-gradient(135deg, #2563eb, #60a5fa)",
    foreground: "#ffffff",
  },
  {
    background: "linear-gradient(135deg, #7c3aed, #c084fc)",
    foreground: "#ffffff",
  },
  {
    background: "linear-gradient(135deg, #059669, #34d399)",
    foreground: "#ffffff",
  },
  {
    background: "linear-gradient(135deg, #ea580c, #fb923c)",
    foreground: "#ffffff",
  },
  {
    background: "linear-gradient(135deg, #db2777, #f472b6)",
    foreground: "#ffffff",
  },
  {
    background: "linear-gradient(135deg, #0891b2, #22d3ee)",
    foreground: "#ffffff",
  },
  {
    background: "linear-gradient(135deg, #ca8a04, #facc15)",
    foreground: "#422006",
  },
  {
    background: "linear-gradient(135deg, #4f46e5, #818cf8)",
    foreground: "#ffffff",
  },
];

function hashString(value: string): number {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function getCreatorAvatarPalette(value: string) {
  const index = hashString(value.toLowerCase()) % creatorAvatarPalettes.length;

  return creatorAvatarPalettes[index];
}

function getPlatformBadgeStyle(
  platform: string | null,
): React.CSSProperties {
  if (platform === "github") {
    return {
      background: "#f3f4f6",
      color: "#111827",
      borderColor: "#d1d5db",
    };
  }

  if (platform === "twitter") {
    return {
      background: "#eff6ff",
      color: "#1d4ed8",
      borderColor: "#bfdbfe",
    };
  }

  if (platform === "youtube") {
    return {
      background: "#fef2f2",
      color: "#dc2626",
      borderColor: "#fecaca",
    };
  }

  if (platform === "medium") {
    return {
      background: "#f0fdf4",
      color: "#166534",
      borderColor: "#bbf7d0",
    };
  }

  if (platform === "substack") {
    return {
      background: "#fff7ed",
      color: "#c2410c",
      borderColor: "#fed7aa",
    };
  }

  return {
    background: "#f8fafc",
    color: "#475569",
    borderColor: "#e2e8f0",
  };
}

function deduplicateVerifiedClaims(
  claims: VerifiedCreatorClaim[],
): VerifiedCreatorClaim[] {
  const deduplicated = new Map<string, VerifiedCreatorClaim>();

  for (const claim of claims) {
    const key =
      claim.claim_scope_key ??
      getClaimUrl(claim) ??
      claim.source_domain ??
      claim.id;

    if (!deduplicated.has(key)) {
      deduplicated.set(key, claim);
    }
  }

  return Array.from(deduplicated.values());
}

const sectionStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 14,
  background: "var(--surface)",
  padding: 16,
  display: "grid",
  gap: 16,
};

const countBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 22,
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 700,
  background: "#eff6ff",
  color: "#2563eb",
  border: "1px solid #dbeafe",
};

const verifiedBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  width: "fit-content",
  minHeight: 22,
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 700,
  color: "#047857",
  background: "#ecfdf5",
  border: "1px solid #a7f3d0",
};

export default async function SourcesPage() {
  const [verifiedClaims, items, sourcePaymentRows] = await Promise.all([
    safeQuery<VerifiedCreatorClaim>(() =>
      supabaseAdmin()
        .from("paylabs_creator_claims")
        .select(
          "id, creator_name, source_url, canonical_url, source_domain, source_platform, claim_scope, claim_scope_key, verified_at"
        )
        .eq("claim_status", "verified")
        .order("verified_at", {
          ascending: false,
          nullsFirst: false,
        })
        .limit(100)
    ),

    safeQuery<FeedItem>(() =>
      supabaseAdmin()
        .from("paylabs_feed_items")
        .select(
          "id, title, summary, canonical_url, author_name, publisher, published_at, creator_wallet, is_monetized, price_per_citation_usdc, price_per_unlock_usdc, normalized_sha256, is_active"
        )
        .eq("is_active", true)
        .order("published_at", {
          ascending: false,
          nullsFirst: false,
        })
        .limit(200)
    ),

    safeQuery<SourcePayment>(() =>
      supabaseAdmin()
        .from("paylabs_source_payments")
        .select("*")
        .eq("status", "completed")
        .order("created_at", { ascending: false })
        .limit(50)
    ),
  ]);

  const deduplicatedClaims = deduplicateVerifiedClaims(
    verifiedClaims,
  ).slice(0, 30);

  return (
    <>
      <SubPageMobileNav />

      <main style={{ display: "grid", gap: 18 }}>
        <header>
          <a href="/chat" className="pl-back-btn">
            ← Back to Chat
          </a>

          <h1 className="page-title" style={{ marginTop: 10 }}>
            Sources
          </h1>

          <p className="muted" style={{ marginTop: 6 }}>
            Discover verified creator sources and source-backed content.
          </p>
        </header>

        {/* ─── Verified Creator Sources ──────────────────────── */}
        <section style={sectionStyle}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "grid", gap: 4 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <h2 className="section-title">
                  Verified Creator Sources
                </h2>

                <span
                  style={{
                    ...countBadgeStyle,
                    background: "#ecfdf5",
                    color: "#047857",
                    borderColor: "#a7f3d0",
                  }}
                >
                  {deduplicatedClaims.length} verified
                </span>
              </div>

              <p className="muted" style={{ fontSize: 13 }}>
                Creators with verified ownership. Content from these sources is
                eligible for attribution and creator rewards.
              </p>
            </div>
          </div>

          {deduplicatedClaims.length === 0 ? (
            <div
              className="muted"
              style={{
                textAlign: "center",
                padding: "28px 16px",
                border: "1px dashed var(--border)",
                borderRadius: 12,
              }}
            >
              No verified creator sources yet.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(220px, 100%), 1fr))",
                gap: 12,
              }}
            >
              {deduplicatedClaims.map((claim) => {
                const displayName = getClaimDisplayName(claim);
                const claimUrl = getClaimUrl(claim);

                const avatarPalette = getCreatorAvatarPalette(
                  claim.claim_scope_key ||
                    claim.source_domain ||
                    displayName,
                );

                return (
                  <article
                    key={claim.id}
                    style={{
                      minHeight: 190,
                      border: "1px solid var(--border)",
                      borderRadius: 12,
                      padding: 14,
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                      background: "var(--surface)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        gap: 10,
                        alignItems: "center",
                      }}
                    >
                      <div
                        aria-hidden="true"
                        style={{
                          width: 44,
                          height: 44,
                          borderRadius: 12,
                          flex: "0 0 auto",
                          display: "grid",
                          placeItems: "center",
                          background: avatarPalette.background,
                          color: avatarPalette.foreground,
                          fontSize: 18,
                          fontWeight: 850,
                          boxShadow:
                            "0 6px 18px rgba(15, 23, 42, 0.12)",
                          border: "1px solid rgba(255,255,255,0.35)",
                        }}
                      >
                        {getInitial(displayName)}
                      </div>

                      <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
                        <div
                          style={{
                            fontWeight: 800,
                            fontSize: 14,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={displayName}
                        >
                          {displayName}
                        </div>

                        {claimUrl ? (
                          <a
                            href={claimUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="muted"
                            title={claimUrl}
                            style={{
                              fontSize: 11,
                              textDecoration: "none",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {shortUrl(claimUrl, 36)}
                          </a>
                        ) : (
                          <span className="muted" style={{ fontSize: 11 }}>
                            {claim.source_domain ?? "Verified source"}
                          </span>
                        )}
                      </div>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 6,
                      }}
                    >
                      <span
                        className="badge"
                        style={getPlatformBadgeStyle(claim.source_platform)}
                      >
                        {platformLabel(claim.source_platform)}
                      </span>

                      <span className="badge">
                        {claimScopeLabel(claim.claim_scope)}
                      </span>
                    </div>

                    <span style={verifiedBadgeStyle}>
                      <span aria-hidden="true">●</span>
                      Verified
                    </span>

                    <p
                      className="muted"
                      style={{
                        margin: 0,
                        fontSize: 12,
                        lineHeight: 1.5,
                      }}
                    >
                      Verified source eligible for attribution and creator
                      monetization.
                    </p>

                    <div
                      className="muted"
                      style={{
                        marginTop: "auto",
                        fontSize: 11,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <span aria-hidden="true">◆</span>

                      <span>
                        {claim.verified_at
                          ? `Verified ${timeAgo(claim.verified_at)}`
                          : "Verified"}
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {/* ─── Indexed Content ──────────────────────────────── */}
        <section style={sectionStyle}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "grid", gap: 4 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <h2 className="section-title">Indexed Content</h2>

                <span style={countBadgeStyle}>{items.length} items</span>
              </div>

              <p className="muted" style={{ fontSize: 13 }}>
                RSSHub feed items and source-backed content catalog.
              </p>
            </div>
          </div>

          {items.length === 0 ? (
            <div
              className="muted"
              style={{
                textAlign: "center",
                padding: 40,
              }}
            >
              No indexed content yet.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(300px, 100%), 1fr))",
                gap: 12,
              }}
            >
              {items.map((item) => (
                <article
                  key={item.id}
                  style={{
                    minHeight: 180,
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    padding: 14,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    background: "var(--surface)",
                  }}
                >
                  <div
                    style={{
                      fontWeight: 800,
                      fontSize: 14,
                      lineHeight: 1.35,
                    }}
                  >
                    {cleanFeedText(item.title) || "(untitled)"}
                  </div>

                  {item.summary ? (
                    <p
                      className="muted"
                      style={{
                        margin: 0,
                        fontSize: 12,
                        lineHeight: 1.5,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {cleanFeedText(item.summary)}
                    </p>
                  ) : null}

                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 6,
                      fontSize: 11,
                    }}
                  >
                    {item.author_name ? (
                      <span className="badge">{item.author_name}</span>
                    ) : null}

                    {item.publisher &&
                    item.publisher !== item.author_name ? (
                      <span className="badge">{item.publisher}</span>
                    ) : null}
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 8,
                      fontSize: 12,
                    }}
                  >
                    <div>
                      <span className="muted">Citation</span>{" "}
                      <span className="data-mono">
                        {item.is_monetized
                          ? usdc(item.price_per_citation_usdc)
                          : "Not monetized"}
                      </span>
                    </div>

                    <div>
                      <span className="muted">Unlock</span>{" "}
                      <span className="data-mono">
                        {item.is_monetized
                          ? usdc(item.price_per_unlock_usdc)
                          : "—"}
                      </span>
                    </div>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 10,
                      marginTop: "auto",
                      fontSize: 11,
                    }}
                  >
                    <a
                      href={item.canonical_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="muted"
                      title={item.canonical_url}
                      style={{
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        textDecoration: "underline",
                      }}
                    >
                      {shortUrl(item.canonical_url, 40)}
                    </a>

                    <span
                      className={
                        item.is_monetized
                          ? "badge badge-success"
                          : "badge"
                      }
                      style={{ flex: "0 0 auto", fontSize: 10 }}
                    >
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
                </article>
              ))}
            </div>
          )}
        </section>

        {/* ─── Source Payments ──────────────────────────────── */}
        <section style={sectionStyle}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "grid", gap: 4 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <h2 className="section-title">Source Payments</h2>

                <span style={countBadgeStyle}>
                  {sourcePaymentRows.length} completed
                </span>
              </div>

              <p className="muted" style={{ fontSize: 13 }}>
                Recent payments for source content through x402 nanopayments.
              </p>
            </div>
          </div>

          {sourcePaymentRows.length === 0 ? (
            <div
              className="muted"
              style={{
                textAlign: "center",
                padding: 28,
              }}
            >
              No source payments yet.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Source</th>
                    <th>Buyer</th>
                    <th>Recipient</th>
                    <th>Type</th>
                    <th>Payment</th>
                    <th>Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>

                <tbody>
                  {sourcePaymentRows.map((payment) => (
                    <tr key={payment.id}>
                      <td className="muted">
                        {timeAgo(payment.created_at)}
                      </td>

                      <td
                        className="muted"
                        style={{
                          maxWidth: 260,
                          fontSize: 11,
                        }}
                      >
                        {payment.source_url ? (
                          <a
                            href={payment.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={payment.source_url}
                          >
                            {shortUrl(payment.source_url, 38)}
                          </a>
                        ) : (
                          "Unknown source"
                        )}
                      </td>

                      <td className="data-mono">
                        {payment.user_wallet
                          ? short(payment.user_wallet)
                          : "—"}
                      </td>

                      <td>
                        <span className="badge">
                          {payment.creator_wallet
                            ? "Creator"
                            : "Treasury"}
                        </span>
                      </td>

                      <td>{payment.payment_kind ?? "—"}</td>

                      <td className="data-mono">
                        {payment.payment_id
                          ? short(payment.payment_id)
                          : "—"}
                      </td>

                      <td className="data-mono">
                        {usdc(payment.amount_usdc)}
                      </td>

                      <td>
                        <span className="badge badge-success">
                          {payment.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
