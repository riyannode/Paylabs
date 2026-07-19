import type { PayLabsOfficeEvent } from "./types";
import { OFFICE_MAX_ACTIVITY_ITEMS } from "./constants";

export function mergeOfficeEvents(
  previous: PayLabsOfficeEvent[],
  incoming: PayLabsOfficeEvent[],
): PayLabsOfficeEvent[] {
  const byKey = new Map<string, PayLabsOfficeEvent>();
  for (const event of previous) {
    byKey.set(event.id || `${event.runId}:${event.sequence}`, event);
  }
  for (const event of incoming) {
    byKey.set(event.id || `${event.runId}:${event.sequence}`, event);
  }
  return Array.from(byKey.values())
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-OFFICE_MAX_ACTIVITY_ITEMS);
}
