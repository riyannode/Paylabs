export type AuthoritativeAnswerProvenance =
  | "evidence_verified"
  | "brain_unverified"
  | "deterministic_failure_fallback";

export type AuthoritativeAnswerCoreResult = {
  assistantResponse: string;
  provenance: AuthoritativeAnswerProvenance;
  groundingFailureMessage: string | null;
};

const INSUFFICIENT_EVIDENCE_MSG = "PayLabs could not find enough relevant evidence to answer this reliably.";
const SYNTHESIS_FAILED_MSG = "PayLabs found relevant sources but could not complete evidence verification for this answer.";
const BRAIN_FALLBACK_NOTE = "Evidence verification could not be completed for this run.";
const PLANNING_ANSWER_OPENING_RE = /^(?:(?:i\s+will\s+(?:provide|compare|explain|analy[sz]e|find|search|look\s+for|gather|review|summari[sz]e)|i\s+can\s+(?:provide|compare|explain|analy[sz]e)|i['’]?ll\s+(?:provide|compare|explain|analy[sz]e|find|search|look\s+for|gather|review|summari[sz]e)|i\s+am\s+(?:processing|searching|looking\s+for|gathering|analy[sz]ing)|let\s+me\s+(?:provide|compare|explain|analy[sz]e|find|search|look\s+for|gather|review|summari[sz]e)|this\s+(?:analysis|answer|response)\s+will\s+(?:provide|compare|explain|cover|show|address)|the\s+(?:following\s+)?answer\s+will\s+(?:provide|compare|explain|cover|show)|saya\s+(?:akan|sedang)\s+(?:memberikan|membandingkan|menjelaskan|menganalisis|mencari|menelusuri|mengumpulkan|memproses)|saya\s+akan\s+(?:memberi|menyajikan|membahas|mengulas)|mohon\s+tunggu(?:\s+sebentar)?|gathering\s+information|searching\s+for)(?:[\s,:—-]|$))/i;

export function isSubstantiveBrainAnswer(value: string | null | undefined): value is string {
  const answer = typeof value === "string" ? value.trim() : "";
  return answer.length > 0 && !PLANNING_ANSWER_OPENING_RE.test(answer);
}

export function selectAuthoritativeAnswerCore(input: {
  groundingVersion: string | null;
  groundingStatus: string | null;
  groundingCitationValidationOk: boolean;
  groundingClaimSupportValidationOk: boolean;
  rawFinalAnswer: string | null;
  brainAssistantResponse: string | null;
  fallbackAnswer: string;
}): AuthoritativeAnswerCoreResult {
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
      provenance: "evidence_verified",
      groundingFailureMessage: null,
    };
  }

  if (isSubstantiveBrainAnswer(input.brainAssistantResponse)) {
    return {
      assistantResponse: input.brainAssistantResponse.trim(),
      provenance: "brain_unverified",
      groundingFailureMessage: BRAIN_FALLBACK_NOTE,
    };
  }

  return {
    assistantResponse: input.groundingStatus === "insufficient_evidence"
      ? INSUFFICIENT_EVIDENCE_MSG
      : input.groundingStatus === "synthesis_failed"
        ? SYNTHESIS_FAILED_MSG
        : input.fallbackAnswer,
    provenance: "deterministic_failure_fallback",
    groundingFailureMessage: null,
  };
}

