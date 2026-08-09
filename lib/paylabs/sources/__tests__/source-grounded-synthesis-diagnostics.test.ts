/**
 * Focused bounded EvidencePack synthesis diagnostics.
 * Run: npx tsx lib/paylabs/sources/__tests__/source-grounded-synthesis-diagnostics.test.ts
 */

import {
  buildSynthesisDiagnostics,
  serializeGroundingSynthesisDiagnostics,
} from "../source-grounded-synthesis";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function expectPass(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${label}`);
    passed++;
  } catch (error) {
    console.log(`  ❌ ${label} — ${(error as Error).message}`);
    failed++;
  }
}

function persisted(
  synthesisFailureCode: string,
  errorCode: string | null,
  meta?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    synthesis_failure_code: synthesisFailureCode,
    ...serializeGroundingSynthesisDiagnostics(buildSynthesisDiagnostics(meta, errorCode)),
  };
}

const expectedKeys = ["status", "paragraphs", "unsupported_claims"];

expectPass("parse failure preserves exact synthesis error code and safe metadata", () => {
  const trace = persisted(
    "structured_output_failed",
    "LLM_STRUCTURED_OUTPUT_PARSE_FAILED",
    {
      mode: "llm_structured_json_extract",
      retry_count: 0,
      json_found: false,
      content_type: "string",
      received_keys: [],
      expected_keys: expectedKeys,
      raw_completion: "RAW_MODEL_COMPLETION_SHOULD_NOT_PERSIST",
      prompt: "RAW_PROMPT_SHOULD_NOT_PERSIST",
      evidence_text: "RAW_EVIDENCE_SHOULD_NOT_PERSIST",
    },
  );

  assert(trace.synthesis_error_code === "LLM_STRUCTURED_OUTPUT_PARSE_FAILED", "parse code was transformed");
  assert(trace.synthesis_mode === "llm_structured_json_extract", "mode was not persisted");
  assert(trace.synthesis_retry_count === 0, "retry count was not persisted");
  assert(trace.synthesis_json_found === false, "json_found was not persisted");
  assert(JSON.stringify(trace.synthesis_expected_keys) === JSON.stringify(expectedKeys), "expected keys changed");
  assert(!JSON.stringify(trace).includes("RAW_MODEL_COMPLETION"), "raw model output leaked");
  assert(!JSON.stringify(trace).includes("RAW_PROMPT"), "prompt leaked");
  assert(!JSON.stringify(trace).includes("RAW_EVIDENCE"), "evidence text leaked");
});

expectPass("validation failure remains distinguishable from parse failure", () => {
  const trace = persisted(
    "structured_output_failed",
    "LLM_VALIDATION_FAILED",
    {
      json_found: true,
      validation_issue_paths: ["paragraphs.0.citation_ids"],
      received_keys: ["status", "paragraphs"],
      expected_keys: expectedKeys,
    },
  );

  assert(trace.synthesis_error_code === "LLM_VALIDATION_FAILED", "validation code was transformed");
  assert(trace.synthesis_json_found === true, "validation json_found was not persisted");
  assert(
    JSON.stringify(trace.synthesis_validation_issue_paths) === JSON.stringify(["paragraphs.0.citation_ids"]),
    "validation issue paths changed",
  );
});

expectPass("timeout keeps both broad and exact timeout codes", () => {
  const trace = persisted("synthesis_timeout", "synthesis_timeout");

  assert(trace.synthesis_failure_code === "synthesis_timeout", "timeout failure code changed");
  assert(trace.synthesis_error_code === "synthesis_timeout", "timeout diagnostic code changed");
  assert(trace.synthesis_mode === null, "timeout fabricated a mode");
  assert(trace.synthesis_retry_count === null, "timeout fabricated retry metadata");
});

expectPass("unavailable and unexpected failures remain distinguishable", () => {
  const unavailable = persisted("llm_unavailable", "LLM_UNAVAILABLE");
  const unexpected = persisted("unexpected_synthesis_error", "unexpected_synthesis_error");

  assert(unavailable.synthesis_error_code === "LLM_UNAVAILABLE", "unavailable code changed");
  assert(unexpected.synthesis_error_code === "unexpected_synthesis_error", "unexpected code changed");
});

expectPass("diagnostic strings, paths, keys, and numbers are bounded", () => {
  const longValue = "x".repeat(200);
  const trace = persisted("structured_output_failed", longValue, {
    mode: longValue,
    retry_count: Number.POSITIVE_INFINITY,
    json_found: "true",
    content_type: longValue,
    validation_issue_paths: Array.from({ length: 12 }, (_, index) => `${index}-${longValue}`),
    received_keys: Array.from({ length: 20 }, (_, index) => `${index}-${longValue}`),
    expected_keys: Array.from({ length: 20 }, (_, index) => `${index}-${longValue}`),
  });

  assert((trace.synthesis_error_code as string).length === 160, "error code exceeded 160 chars");
  assert((trace.synthesis_mode as string).length === 160, "mode exceeded 160 chars");
  assert(trace.synthesis_retry_count === null, "non-finite retry count persisted");
  assert(trace.synthesis_json_found === null, "non-boolean json_found persisted");
  assert((trace.synthesis_validation_issue_paths as string[]).length === 8, "paths exceeded bound");
  assert((trace.synthesis_received_keys as string[]).length === 12, "received keys exceeded bound");
  assert((trace.synthesis_expected_keys as string[]).length === 12, "expected keys exceeded bound");
  assert((trace.synthesis_content_type as string).length === 160, "content type exceeded 160 chars");
});

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───`);
process.exit(failed > 0 ? 1 : 0);
