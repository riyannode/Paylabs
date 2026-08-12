import type { AnswerProvenance, GroundingStatus } from "./types";

export type AuthoritativeAnswerSelection = {
  assistantResponse: string;
  answerProvenance: AnswerProvenance;
  groundingFailureMessage: string | null;
};

const INSUFFICIENT_EVIDENCE_MSG = "PayLabs could not find enough relevant evidence to answer this reliably.";
const SYNTHESIS_FAILED_MSG = "PayLabs found relevant sources but could not complete evidence verification for this answer.";
const BRAIN_FALLBACK_NOTE = "Evidence verification could not be completed for this run.";

// Brain planning text is useful only when it is an actual answer, not a promise/status update.
// Keep this opening-focused: legitimate answers may contain future-tense wording later.
const PLANNING_ANSWER_OPENING_RE = /^(?:(?:i\s+will\s+(?:provide|compare|explain|analy[sz]e|find|search|look\s+for|gather|review|summari[sz]e)|i\s+can\s+(?:provide|compare|explain|analy[sz]e)|i['’]?ll\s+(?:provide|compare|explain|analy[sz]e|find|search|look\s+for|gather|review|summari[sz]e)|i\s+am\s+(?:processing|searching|looking\s+for|gathering|analy[sz]ing)|let\s+me\s+(?:provide|compare|explain|analy[sz]e|find|search|look\s+for|gather|review|summari[sz]e)|this\s+(?:analysis|answer|response)\s+will\s+(?:provide|compare|explain|cover|show|address)|the\s+(?:following\s+)?answer\s+will\s+(?:provide|compare|explain|cover|show)|saya\s+(?:akan|sedang)\s+(?:memberikan|membandingkan|menjelaskan|menganalisis|mencari|menelusuri|mengumpulkan|memproses)|saya\s+akan\s+(?:memberi|menyajikan|membahas|mengulas)|mohon\s+tunggu(?:\s+sebentar)?|gathering\s+information|searching\s+for)(?:[\s,:—-]|$))/i;

export function isSubstantiveBrainAnswer(value: string | null | undefined): value is string {
  const answer = typeof value === "string" ? value.trim() : "";
  return answer.length > 0 && !PLANNING_ANSWER_OPENING_RE.test(answer);
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
