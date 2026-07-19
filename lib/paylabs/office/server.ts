import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { PayLabsOfficeEvent } from "./types";

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
  const { data: sequence, error: sequenceError } = await supabase.rpc(
    "next_paylabs_office_sequence",
    { p_run_id: input.runId },
  );
  if (sequenceError) throw new Error(`Office sequence failed: ${sequenceError.message}`);
  const event: PayLabsOfficeEvent = {
    ...input,
    id: randomUUID(),
    sequence: Number(sequence),
    createdAt: new Date().toISOString(),
  };
  const { error } = await supabase.from("paylabs_office_events").insert({
    id: event.id,
    run_id: event.runId,
    sequence: event.sequence,
    event_type: event.type,
    agent_id: event.agentId ?? null,
    phase: event.phase ?? null,
    status: event.status ?? null,
    title: event.title,
    message: event.message ?? null,
    payment: event.payment ?? null,
    metadata: event.metadata ?? null,
    created_at: event.createdAt,
  });
  if (error) throw new Error(`Office event insert failed: ${error.message}`);
  return event;
}

export async function safeEmitOfficeEvent(
  input: Omit<PayLabsOfficeEvent, "id" | "sequence" | "createdAt">,
): Promise<void> {
  try {
    await emitOfficeEvent(input);
  } catch (error) {
    console.error("[paylabs-office-event]", boundedError(error));
  }
}
