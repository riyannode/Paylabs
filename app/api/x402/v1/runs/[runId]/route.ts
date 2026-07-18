import { NextRequest, NextResponse } from "next/server";
import { publicError } from "@/lib/paylabs/public-api/errors";
import { loadAuthorizedPublicRun } from "@/lib/paylabs/public-api/read";
import { buildPublicRunResponse } from "@/lib/paylabs/public-api/response";

export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const token = req.nextUrl.searchParams.get("read_token") || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || null;
  const run = await loadAuthorizedPublicRun(runId, token);
  if (run === false) return publicError("READ_TOKEN_INVALID", "Invalid read token.");
  if (!run) return publicError("RUN_NOT_FOUND", "Run not found.");
  return NextResponse.json(buildPublicRunResponse(run, null, "compact"));
}
