import type { AnswerProvenance, GroundingStatus } from "./types";

export type AuthoritativeAnswerSelection = {
  assistantResponse: string;
  answerProvenance: AnswerProvenance;
  groundingFailureMessage: string | null;
};

const INSUFFICIENT_EVIDENCE_MSG = "PayLabs could not find enough relevant evidence to answer this reliably.";
const SYNTHESIS_FAILED_MSG = "PayLabs found relevant sources but could not complete evidence verification for this answer.";
const BRAIN_FALLBACK_NOTE = "Evidence verification could not be completed for this run.";

// Brain planning text is useful only when it is an actual answer, not a progress update.
const GENERIC_ANSWER_RE = /^(i will find|i will search|i am processing|let me find|i'll look|i'll search|saya akan mencari|saya sedang memproses|mohon tunggu sebentar|gathering information|i'm searching for|i'm looking for|saya sedang mencari)/i;

export function isSubstantiveBrainAnswer(value: string | null | undefined): value is string {
  const answer = typeof value === "string" ? value.trim() : "";
  return answer.length > 0 && !(GENERIC_ANSWER_RE.test(answer) && answer.length < 200);
}

function deterministicFailureAnswer(status: GroundingStatus | null, fallbackAnswer: string): string {
  if (status === "insufficient_evidence") return INSUFFICIENT_EVIDENCE_MSG;
  if (status === "synthesis_failed") return SYNTHESIS_FAILED_MSG;
  return fallbackAnswer;
}

export function selectAuthoritativeAnswer(input: {
  groundingVersion: string | null;
  groundingStatus: GroundingStatus | null;
  groundingCitationValidationOk: boolean;
  groundingClaimSupportValidationOk: boolean;
  rawFinalAnswer: string | null;
  brainAssistantResponse: string | null;
  fallbackAnswer: string;
}): AuthoritativeAnswerSelection {
  const rawFinalAnswer = input.rawFinalAnswer?.trim() ?? "";
  const evidenceVerified =
    input.groundingVersion === "grounded_answer_v2" &&
    (input.groundingStatus === "grounded" || input.groundingStatus === "partially_grounded") &&
    input.groundingCitationValidationOk &&
    input.groundingClaimSupportValidationOk &&
    rawFinalAnswer.length > 0;

  if (evidenceVerified) {
    return {
      assistantResponse: rawFinalAnswer,
      answerProvenance: "evidence_verified",
      groundingFailureMessage: null,
    };
  }

  if (isSubstantiveBrainAnswer(input.brainAssistantResponse)) {
    return {
      assistantResponse: input.brainAssistantResponse.trim(),
      answerProvenance: "brain_unverified",
      groundingFailureMessage: BRAIN_FALLBACK_NOTE,
    };
  }

  return {
    assistantResponse: deterministicFailureAnswer(input.groundingStatus, input.fallbackAnswer),
    answerProvenance: "fallback",
    groundingFailureMessage: null,
  };
}
