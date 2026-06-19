import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

// Hardcoded AI Tutor: picks relevant lessons based on goal keywords
// No external LLM call needed for MVP - deterministic path proposal
function matchLessons(lessons: any[], goal: string, budget: number) {
  const goalLower = goal.toLowerCase();
  const scored = lessons.map((l) => {
    let score = 0;
    const text = `${l.title} ${l.summary} ${l.tags?.join(" ")}`.toLowerCase();
    // Keyword matching
    for (const word of goalLower.split(/\s+/)) {
      if (word.length > 2 && text.includes(word)) score += 2;
    }
    // Tag matching
    for (const tag of l.tags || []) {
      if (goalLower.includes(tag.toLowerCase())) score += 3;
    }
    // Boost cheaper lessons to fit more in budget
    score += (1 / l.price_usdc) * 0.001;
    return { ...l, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Greedy: pick highest scoring lessons that fit budget
  const selected: any[] = [];
  let remaining = budget;
  for (const l of scored) {
    if (l.price_usdc <= remaining && selected.length < 5) {
      selected.push(l);
      remaining -= l.price_usdc;
    }
  }

  return selected.map((l) => ({
    id: l.id,
    slug: l.slug,
    title: l.title,
    price_usdc: Number(l.price_usdc),
    reason: generateReason(l, goalLower),
  }));
}

function generateReason(lesson: any, goal: string): string {
  const reasons = [
    `Covers key concepts needed for: ${goal.slice(0, 60)}`,
    `Source-backed lesson from ${lesson.source?.source_title || "verified source"}`,
    `Foundational for understanding ${lesson.tags?.[0] || "the topic"}`,
    `Builds on prior knowledge for ${lesson.difficulty} level learners`,
    `Essential for the learning path toward your goal`,
  ];
  return reasons[Math.floor(Math.random() * reasons.length)];
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { goal, budget_usdc } = body;

  if (!goal || !budget_usdc || budget_usdc <= 0) {
    return NextResponse.json({ error: "Goal and positive budget required" }, { status: 400 });
  }

  const { data: lessons, error } = await supabaseAdmin()
    .from("paylabs_lessons")
    .select("id, slug, title, summary, price_usdc, difficulty, tags, source:paylabs_sources(source_title)")
    .eq("is_published", true)
    .order("price_usdc");

  if (error || !lessons) {
    return NextResponse.json({ error: "Could not fetch lessons" }, { status: 500 });
  }

  const path = matchLessons(lessons, goal, budget_usdc);
  const total = path.reduce((s, l) => s + l.price_usdc, 0);

  return NextResponse.json({
    goal,
    budget_usdc,
    path,
    total_usdc: total,
    remaining_usdc: budget_usdc - total,
  });
}
