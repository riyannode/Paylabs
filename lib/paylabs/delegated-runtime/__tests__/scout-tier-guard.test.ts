/**
 * Standalone assertions for assertValidDiscoveryScoutBundle
 * Run: npx tsx lib/paylabs/delegated-runtime/__tests__/scout-tier-guard.test.ts
 */

import { assertValidDiscoveryScoutBundle } from "../tier-service-bundles";

let passed = 0;
let failed = 0;

function expectPass(tier: string, services: string[], label: string) {
  try {
    assertValidDiscoveryScoutBundle(tier as "easy" | "normal" | "advanced", services as any);
    console.log(`  ✅ ${label}`);
    passed++;
  } catch (e: unknown) {
    console.log(`  ❌ ${label} — UNEXPECTED THROW: ${(e as Error).message}`);
    failed++;
  }
}

function expectFail(tier: string, services: string[], label: string, expectedMsg?: string) {
  try {
    assertValidDiscoveryScoutBundle(tier as "easy" | "normal" | "advanced", services as any);
    console.log(`  ❌ ${label} — EXPECTED THROW but passed`);
    failed++;
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (expectedMsg && !msg.includes(expectedMsg)) {
      console.log(`  ❌ ${label} — wrong error: ${msg}`);
      failed++;
    } else {
      console.log(`  ✅ ${label}`);
      passed++;
    }
  }
}

console.log("\n─── Scout Tier Guard Tests ───\n");

console.log("Easy tier:");
expectPass("easy", ["intent_planner", "query_builder", "signal_scout_basics"], "easy + signal_scout_basics → pass");
expectFail("easy", ["intent_planner", "query_builder", "signal_scout"], "easy + signal_scout → fail", "easy tier requires signal_scout_basics");

console.log("\nNormal tier:");
expectPass("normal", ["intent_planner", "query_builder", "signal_scout"], "normal + signal_scout → pass");
expectFail("normal", ["intent_planner", "query_builder", "signal_scout_basics"], "normal + signal_scout_basics → fail", "normal tier requires signal_scout");

console.log("\nAdvanced tier:");
expectPass("advanced", ["intent_planner", "query_builder", "signal_scout"], "advanced + signal_scout → pass");
expectFail("advanced", ["intent_planner", "query_builder", "signal_scout_basics"], "advanced + signal_scout_basics → fail", "advanced tier requires signal_scout");

console.log("\nBoth variants:");
expectFail("easy", ["signal_scout", "signal_scout_basics"], "both scouts → fail", "both signal_scout and signal_scout_basics");
expectFail("normal", ["signal_scout", "signal_scout_basics"], "both scouts (normal) → fail", "both signal_scout and signal_scout_basics");

console.log("\nNeither variant:");
expectFail("easy", ["intent_planner", "query_builder"], "no scout → fail", "no scout service selected");
expectFail("normal", ["intent_planner", "query_builder"], "no scout (normal) → fail", "no scout service selected");
expectFail("advanced", [], "empty array → fail", "no scout service selected");

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
process.exit(failed > 0 ? 1 : 0);
