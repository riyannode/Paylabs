import type { AnswerProvenance, GroundingStatus } from "./types";
import {
  isSubstantiveBrainAnswer,
  selectAuthoritativeAnswerCore,
} from "@/lib/paylabs/chat/answer-selection-core";

export type AuthoritativeAnswerSelection = {
  assistantResponse: string;
  answerProvenance: AnswerProvenance;
  groundingFailureMessage: string | null;
};

export { isSubstantiveBrainAnswer };

export function selectAuthoritativeAnswer(input: {
  groundingVersion: string | null;
  groundingStatus: GroundingStatus | null;
  groundingCitationValidationOk: boolean;
  groundingClaimSupportValidationOk: boolean;
  rawFinalAnswer: string | null;
  brainAssistantResponse: string | null;
  fallbackAnswer: string;
}): AuthoritativeAnswerSelection {
  const selected = selectAuthoritativeAnswerCore(input);
  return {
    assistantResponse: selected.assistantResponse,
    answerProvenance: selected.provenance === "deterministic_failure_fallback"
      ? "fallback"
      : selected.provenance,
    groundingFailureMessage: selected.groundingFailureMessage,
  };
}
