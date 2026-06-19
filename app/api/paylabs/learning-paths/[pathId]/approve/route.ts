// POST /api/paylabs/learning-paths/[pathId]/approve
// User approves a proposed learning path before agent can buy.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ pathId: string }> }
) {
  const { pathId } = await params;
  const body = await req.json();
  const { user_wallet } = body;

  if (!user_wallet || !user_wallet.startsWith("0x") || user_wallet.length !== 42) {
    return NextResponse.json(
      { error: "user_wallet must be a valid EVM address" },
      { status: 400 }
    );
  }

  if (!pathId) {
    return NextResponse.json({ error: "pathId required" }, { status: 400 });
  }

  // 1. Get path
  const { data: path, error: pathErr } = await supabaseAdmin()
    .from("paylabs_learning_paths")
    .select("*")
    .eq("id", pathId)
    .single();

  if (pathErr || !path) {
    return NextResponse.json({ error: "Path not found" }, { status: 404 });
  }

  // 2. Verify ownership
  if (path.user_wallet.toLowerCase() !== user_wallet.toLowerCase()) {
    return NextResponse.json(
      { error: "Path does not belong to this wallet" },
      { status: 403 }
    );
  }

  // 3. Verify status
  if (path.status !== "proposed") {
    return NextResponse.json(
      { error: `Path status is '${path.status}', must be 'proposed'` },
      { status: 400 }
    );
  }

  // 4. Verify budget
  if (Number(path.estimated_total_usdc) > Number(path.budget_usdc)) {
    return NextResponse.json(
      { error: "Estimated total exceeds budget" },
      { status: 400 }
    );
  }

  // 5. Approve path
  const { data: updated, error: updateErr } = await supabaseAdmin()
    .from("paylabs_learning_paths")
    .update({ status: "approved" })
    .eq("id", pathId)
    .select("id, status")
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // 6. Update path items from "proposed" to "approved"
  await supabaseAdmin()
    .from("paylabs_learning_path_items")
    .update({ status: "approved" })
    .eq("path_id", pathId)
    .eq("status", "proposed");

  return NextResponse.json({
    path_id: updated.id,
    path_status: updated.status,
    message: "Path approved. Agent can now buy lessons in this path.",
  });
}
