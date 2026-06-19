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

  const paragraphs = lesson.body_markdown.split("\n\n");
  const preview = paragraphs.slice(0, 3).join("\n\n");

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <a href="/learn" className="muted" style={{ fontSize: 14 }}>← Back to catalog</a>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>{lesson.title}</h1>
          <span className="data-mono" style={{ fontWeight: 700, color: "var(--success)", fontSize: 20 }}>
            {formatUsdc(lesson.price_usdc)}
          </span>
        </div>

        <p className="muted" style={{ marginBottom: 12 }}>{lesson.summary}</p>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <span className={`badge badge-${lesson.difficulty}`}>{lesson.difficulty}</span>
          {lesson.tags?.map((t: string) => (
            <span key={t} className="muted" style={{ fontSize: 12 }}>#{t}</span>
          ))}
        </div>

        {lesson.source && (
          <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
            Source: <a href={lesson.source.canonical_url} target="_blank" style={{ textDecoration: "underline" }}>{lesson.source.source_title}</a>
          </div>
        )}

        {lesson.creator && (
          <div className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
            Creator: {lesson.creator.display_name} ({shortAddress(lesson.creator.wallet_address)})
          </div>
        )}

        <div className="card-soft data-mono" style={{ fontSize: 12, marginBottom: 20 }}>
          Revenue split: Creator {split.creator.toFixed(6)} (85%) · Platform {split.platform.toFixed(6)} (10%) · Treasury {split.treasury.toFixed(6)} (5%)
        </div>

        <div style={{ marginBottom: 20 }}>
          <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>Preview</div>
          <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.7, fontSize: 14 }}>{preview}</div>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 20 }}>
          <div style={{ textAlign: "center", padding: 24, background: "var(--card-soft)", borderRadius: 12 }}>
            <p className="muted" style={{ marginBottom: 16, fontSize: 14 }}>
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
