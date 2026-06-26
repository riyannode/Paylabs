/**
 * GET /api/paylabs/dcw/run-paid/status?jobId=...
 *
 * Poll async DCW run-paid job status.
 * Returns: { ok, status, progress, result?, error? }
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/paylabs/auth/session";
import { getJob } from "@/lib/paylabs/dcw/job-store";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
  }

  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) {
    return NextResponse.json({ ok: false, error: "jobId required" }, { status: 400 });
  }

  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ ok: false, error: "Job not found or expired" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    result: job.status === "completed" ? job.result : undefined,
    error: job.status === "failed" ? job.error : undefined,
  });
}
