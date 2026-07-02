import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { ok: false, error: "inline_route_removed_use_route_preflight_execute_locked" },
    { status: 410 },
  );
}
