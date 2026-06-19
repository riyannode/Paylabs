import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

// Deterministic path proposal: keyword matching + budget fit
// Persists path + items to DB so buy-lesson can enforce approval policy

function matchLessons(lessons: any[], goal: string, budget: number) {
  const goalLower = goal.toLowerCase();
  const scored = lessons.map((l) => {
    let score = 0;
    const text = `${l.title} ${l.summary} ${l.tags?.join(" ")}`.toLowerCase();
    for (const word of goalLower.split(/\s+/)) {
      if (word.length > 2 && text.includes(word)) score += 2;
    }
    for (const tag of l.tags || []) {
      if (goalLower.includes(tag.toLowerCase())) score += 3;
    }
    score += (1 / l.price_usdc) * 0.001;
    return { ...l, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected: any[] = [];
  let remaining = budget;
  for (const l of scored) {
    if (l.price_usdc <= remaining && selected.length < 5) {
      selected.push(l);
      remaining -= l.price_usdc;
    }
  }

  return selected.map((l, i) => ({
    id: l.id,
    slug: l.slug,
    title: l.title,
    price_usdc: Number(l.price_usdc),
    reason: generateReason(l, goalLower),
    order_index: i,
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
  const { goal, budget_usdc, user_wallet } = body;

  if (!goal || !budget_usdc || budget_usdc <= 0) {
    return NextResponse.json({ error: "Goal and positive budget required" }, { status: 400 });
  }
  if (!user_wallet || !user_wallet.startsWith("0x") || user_wallet.length !== 42) {
    return NextResponse.json({ error: "user_wallet must be a valid EVM address" }, { status: 400 });
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

  if (path.length === 0) {
    return NextResponse.json({ error: "No matching lessons found within budget" }, { status: 404 });
  }

  // Persist learning path to DB
  const { data: pathRow, error: pathErr } = await supabaseAdmin()
    .from("paylabs_learning_paths")
    .insert({
      user_wallet: user_wallet.toLowerCase(),
      goal,
      budget_usdc,
      estimated_total_usdc: total,
      agent_reasoning_summary: `Matched ${path.length} lessons for goal: ${goal.slice(0, 100)}`,
      status: "proposed",
      created_by_agent_id: "paylabs-tutor",
    })
    .select("id, status")
    .single();

  if (pathErr || !pathRow) {
    return NextResponse.json({ error: pathErr?.message || "Could not create learning path" }, { status: 500 });
  }

  // Persist path items
  const pathItems = path.map((l, i) => ({
    path_id: pathRow.id,
    lesson_id: l.id,
    order_index: i,
    reason: l.reason,
    expected_value: `Learn ${l.title}`,
    status: "proposed",
  }));

  const { error: itemsErr } = await supabaseAdmin()
    .from("paylabs_learning_path_items")
    .insert(pathItems);

  if (itemsErr) {
    // Clean up the path if items fail
    await supabaseAdmin().from("paylabs_learning_paths").delete().eq("id", pathRow.id);
    return NextResponse.json({ error: itemsErr.message }, { status: 500 });
  }

  return NextResponse.json({
    path_id: pathRow.id,
    path_status: pathRow.status,
    goal,
    budget_usdc,
    path,
    total_usdc: total,
    remaining_usdc: budget_usdc - total,
  });
}
