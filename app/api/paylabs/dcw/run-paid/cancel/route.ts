/**
 * POST /api/paylabs/dcw/run-paid/cancel
 *
 * Cancel a running DCW run-paid job.
 * Body: { jobId: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { cancelJob } from "@/lib/paylabs/dcw/job-store";

export async function POST(req: NextRequest) {
  const { jobId } = await req.json().catch(() => ({}));
  if (!jobId) {
    return NextResponse.json({ ok: false, error: "jobId required" }, { status: 400 });
  }

  const cancelled = cancelJob(jobId);
  return NextResponse.json({ ok: cancelled });
}
