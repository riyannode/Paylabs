/**
 * In-memory job store for async DCW run-paid.
 *
 * Jobs are stored in a module-level Map that persists across warm Vercel
 * invocations.  Cold starts lose state — the frontend handles this by
 * treating a missing jobId as "retry needed".
 *
 * Each job transitions: pending → running → completed | failed | cancelled
 * Auto-expire after 5 minutes.
 */

export type DcwJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface DcwJob {
  id: string;
  status: DcwJobStatus;
  /** Original request body (goal, routeTier, budgetUsdc) */
  request: { goal: string; routeTier: string; budgetUsdc: number };
  /** Set once completed */
  result: Record<string, unknown> | null;
  /** Set once failed */
  error: string | null;
  /** Progress message (e.g. "Approving…", "Submitting deposit…") */
  progress: string;
  createdAt: number;
  completedAt: number | null;
  /** AbortController for cancelling the underlying fetch */
  abortController: AbortController | null;
}

const jobs = new Map<string, DcwJob>();
const JOB_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Clean up expired jobs (call periodically). */
function gc() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}

export function createJob(
  id: string,
  request: DcwJob["request"],
): DcwJob {
  gc();
  const job: DcwJob = {
    id,
    status: "pending",
    request,
    result: null,
    error: null,
    progress: "Starting…",
    createdAt: Date.now(),
    completedAt: null,
    abortController: new AbortController(),
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): DcwJob | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, patch: Partial<DcwJob>): void {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
  if (patch.status === "completed" || patch.status === "failed" || patch.status === "cancelled") {
    job.completedAt = Date.now();
  }
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    return false;
  }
  job.abortController?.abort();
  job.status = "cancelled";
  job.completedAt = Date.now();
  job.progress = "Cancelled";
  return true;
}
