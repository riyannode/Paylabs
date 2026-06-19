import { supabaseAdmin } from "@/lib/supabase/server";
import { shortAddress, formatUsdc } from "@/lib/utils";
import { buildX402Challenge } from "@/lib/payments/x402";
import { computeSplit } from "@/lib/payments/receipt";
import UnlockButton from "@/components/UnlockButton";

export const dynamic = "force-dynamic";

async function getLesson(slug: string) {
  const { data } = await supabaseAdmin()
    .from("paylabs_lessons")
    .select("*, creator:paylabs_creators(*), source:paylabs_sources(*)")
    .eq("slug", slug)
    .eq("is_published", true)
    .single();
  return data;
}

export default async function LessonPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const lesson = await getLesson(slug);

  if (!lesson) {
    return <div className="card"><h2>Lesson not found</h2></div>;
  }

  const receiverAddress = process.env.X402_RECEIVER_ADDRESS || "";
  const challenge = buildX402Challenge(receiverAddress, lesson.price_usdc);
  const split = computeSplit(lesson.price_usdc);

  // Preview: first 3 paragraphs
  const paragraphs = lesson.body_markdown.split("\n\n");
  const preview = paragraphs.slice(0, 3).join("\n\n");
  const remaining = paragraphs.slice(3).join("\n\n");

  return (
    <div>
      <a href="/learn" style={{ fontSize: "0.875rem" }}>&larr; Back to catalog</a>

      <div className="card" style={{ marginTop: "1rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.5rem" }}>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700, margin: 0 }}>{lesson.title}</h1>
          <span style={{ fontWeight: 700, color: "var(--accent-green)", fontSize: "1.25rem" }}>
            {formatUsdc(lesson.price_usdc)}
          </span>
        </div>

        <p style={{ color: "var(--muted)", marginBottom: "1rem" }}>{lesson.summary}</p>

        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
          <span className={`badge badge-${lesson.difficulty}`}>{lesson.difficulty}</span>
          {lesson.tags?.map((t: string) => (
            <span key={t} style={{ fontSize: "0.75rem", color: "var(--muted)" }}>#{t}</span>
          ))}
        </div>

        {lesson.source && (
          <div style={{ fontSize: "0.8rem", color: "var(--muted)", marginBottom: "0.5rem" }}>
            Source: <a href={lesson.source.canonical_url} target="_blank">{lesson.source.source_title}</a>
            {lesson.source.normalized_sha256 && (
              <span> | hash: {lesson.source.normalized_sha256.slice(0, 16)}...</span>
            )}
          </div>
        )}

        {lesson.creator && (
          <div style={{ fontSize: "0.8rem", color: "var(--muted)", marginBottom: "1rem" }}>
            Creator: {lesson.creator.display_name} ({shortAddress(lesson.creator.wallet_address)})
          </div>
        )}

        {/* Revenue split preview */}
        <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginBottom: "1.5rem", padding: "0.5rem", background: "rgba(255,255,255,0.03)", borderRadius: 8 }}>
          Revenue split: Creator {split.creator.toFixed(6)} (85%) | Platform {split.platform.toFixed(6)} (10%) | Treasury {split.treasury.toFixed(6)} (5%)
        </div>

        {/* Preview (always visible) */}
        <div style={{ marginBottom: "1.5rem" }}>
          <h3 style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--muted)", marginBottom: "0.5rem" }}>PREVIEW</h3>
          <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.7, fontSize: "0.9rem" }}>{preview}</div>
        </div>

        {/* Locked content */}
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: "1.5rem" }}>
          <div style={{ textAlign: "center", padding: "2rem", background: "rgba(255,255,255,0.02)", borderRadius: 8 }}>
            <p style={{ color: "var(--muted)", marginBottom: "1rem" }}>
              Full lesson locked. Pay {formatUsdc(lesson.price_usdc)} via x402 to unlock.
            </p>
            <UnlockButton
              lessonId={lesson.id}
              lessonSlug={lesson.slug}
              priceUsdc={lesson.price_usdc}
              challenge={challenge}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
