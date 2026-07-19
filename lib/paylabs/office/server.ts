import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { PayLabsOfficeEvent } from "./types";
import { sanitizeOfficeEvent } from "./sanitizer";

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing Supabase office event configuration");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 280);
}

export async function emitOfficeEvent(
  input: Omit<PayLabsOfficeEvent, "id" | "sequence" | "createdAt">,
): Promise<PayLabsOfficeEvent> {
  const supabase = getAdminClient();
  const id = randomUUID();
  const { data, error } = await supabase.rpc("emit_paylabs_office_event", {
    p_id: id,
    p_run_id: input.runId,
    p_event_type: input.type,
    p_agent_id: input.agentId ?? null,
    p_phase: input.phase ?? null,
    p_status: input.status ?? null,
    p_title: input.title,
    p_message: input.message ?? null,
    p_payment: input.payment ?? null,
    p_metadata: input.metadata ?? null,
  });
  if (error) throw new Error(`Office event emit failed: ${error.message}`);
  const row = data as {
    id: string;
    sequence: number | string;
    created_at: string;
  } | null;
  if (!row?.id || row.sequence == null || !row.created_at) {
    throw new Error("Office event emit returned no row");
  }
  return {
    ...input,
    id: row.id,
    sequence: Number(row.sequence),
    createdAt: row.created_at,
  };
}

export async function safeEmitOfficeEvent(
  input: Omit<PayLabsOfficeEvent, "id" | "sequence" | "createdAt">,
): Promise<void> {
  try {
    await emitOfficeEvent(sanitizeOfficeEvent(input));
  } catch (error) {
    console.error("[paylabs-office-event]", boundedError(error));
  }
}
