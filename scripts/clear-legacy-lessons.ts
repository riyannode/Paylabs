/**
 * clear-legacy-lessons.ts
 *
 * Clears legacy internal lesson catalog data.
 * Run manually: pnpm clear:legacy-lessons
 * With payment tables: pnpm clear:legacy-lessons --include-payments
 *
 * NEVER runs automatically. NEVER truncates citation receipts.
 * Prints counts only, never secrets.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const INCLUDE_PAYMENTS = process.argv.includes("--include-payments");

interface TableResult {
  table: string;
  deleted: number;
  error?: string;
}

async function truncateTable(
  table: string,
  condition?: string
): Promise<TableResult> {
  try {
    let query = supabase.from(table).delete();
    if (condition) {
      query = query.neq("id", "00000000-0000-0000-0000-000000000000");
    } else {
      query = query.neq("id", "00000000-0000-0000-0000-000000000000");
    }
    const { error, count } = await query;
    if (error) return { table, deleted: 0, error: error.message };
    return { table, deleted: count ?? 0 };
  } catch (e: any) {
    return { table, deleted: 0, error: e.message };
  }
}

async function main() {
  console.log("=== PayLabs Legacy Internal Lesson Cleanup ===\n");

  // Order matters: children first
  const tables = [
    "paylabs_learning_path_items",
    "paylabs_learning_paths",
    "paylabs_unlocks",
    "paylabs_payout_receipts",
    "paylabs_lessons",
    "paylabs_sources",
  ];

  const paymentTables = ["paylabs_route_toll_calls", "paylabs_agent_service_calls"];

  const results: TableResult[] = [];

  for (const table of tables) {
    const r = await truncateTable(table);
    results.push(r);
  }

  if (INCLUDE_PAYMENTS) {
    console.log("\n⚠️  --include-payments flag detected: clearing payment tables\n");
    for (const table of paymentTables) {
      const r = await truncateTable(table);
      results.push(r);
    }
  }

  console.log("Results:");
  console.log("─".repeat(50));
  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.table}: ERROR — ${r.error}`);
    } else {
      console.log(`  ${r.table}: ${r.deleted} rows deleted`);
    }
  }
  console.log("─".repeat(50));
  console.log("\nDone. No secrets printed.");
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
