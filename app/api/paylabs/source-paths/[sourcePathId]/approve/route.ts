// POST /api/paylabs/source-paths/[sourcePathId]/approve
//
// Approve a proposed source path so payments can proceed.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sourcePathId: string }> }
) {
  const { sourcePathId } = await params;
  const body = await req.json();
  const { user_wallet } = body;

  if (!user_wallet || !user_wallet.startsWith("0x") || user_wallet.length !== 42) {
    return NextResponse.json(
      { error: "user_wallet must be a valid EVM address" },
      { status: 400 }
    );
  }

  // Verify path exists and belongs to user
  const { data: path, error: pathErr } = await supabaseAdmin()
    .from("paylabs_source_paths")
    .select("id, user_wallet, status")
    .eq("id", sourcePathId)
    .single();

  if (pathErr || !path) {
    return NextResponse.json({ error: "Source path not found" }, { status: 404 });
  }

  if (path.user_wallet.toLowerCase() !== user_wallet.toLowerCase()) {
    return NextResponse.json({ error: "Not your source path" }, { status: 403 });
  }

  if (path.status !== "proposed") {
    return NextResponse.json(
      { error: `Cannot approve path in status: ${path.status}` },
      { status: 400 }
    );
  }

  // Update status to approved
  const { error: updateErr } = await supabaseAdmin()
    .from("paylabs_source_paths")
    .update({ status: "approved" })
    .eq("id", sourcePathId);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({
    source_path_id: sourcePathId,
    source_path_status: "approved",
  });
}
