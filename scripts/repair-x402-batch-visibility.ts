import { supabaseAdmin } from "../lib/paylabs/db/server";
import { clearSettlementBatch, persistSettlementBatch, resolveSettlementBatch } from "../lib/paylabs/x402/batch-resolver";

const apply = process.argv.includes("--apply");

async function main() {
  const db = supabaseAdmin();
  const [{ data: services }, { data: events }, { data: runs }] = await Promise.all([
    db.from("paylabs_service_payment_events").select("settlement_id, batch_tx_hash").not("settlement_id", "is", null),
    db.from("paylabs_run_events").select("settlement_id, batch_tx_hash").not("settlement_id", "is", null),
    db.from("paylabs_discovery_runs").select("entry_payment_settlement_id, entry_payment_batch_tx_hash").not("entry_payment_settlement_id", "is", null),
  ]);

  const oldHashes = new Map<string, Set<string>>();
  const add = (settlementId: string | null, hash: string | null) => {
    if (!settlementId) return;
    if (!oldHashes.has(settlementId)) oldHashes.set(settlementId, new Set());
    if (hash) oldHashes.get(settlementId)!.add(hash);
  };
  for (const row of services ?? []) add(row.settlement_id, row.batch_tx_hash);
  for (const row of events ?? []) add(row.settlement_id, row.batch_tx_hash);
  for (const row of runs ?? []) add(row.entry_payment_settlement_id, row.entry_payment_batch_tx_hash);

  for (const settlementId of [...oldHashes.keys()].sort()) {
    const result = await resolveSettlementBatch(settlementId, { persist: false });
    const resolved = result.batchTxHash;
    console.log(JSON.stringify({ settlementId, oldHashes: [...oldHashes.get(settlementId)!].sort(), resolvedHash: resolved, matchedBy: result.matchedBy, status: result.status }));
    if (apply) {
      if (resolved) await persistSettlementBatch(settlementId, resolved);
      else await clearSettlementBatch(settlementId);
    }
  }
  if (!apply) console.error("Dry run only. Re-run with --apply to write resolved hashes; unresolved candidates are never written.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
