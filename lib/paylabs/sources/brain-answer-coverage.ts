import {
  extractQueryRequirements,
  matchesRequestedAspect,
  type QueryRequirements,
  type QuerySubjectConstraint,
  type RequestedAspectConstraint,
} from "./query-requirements";
import { getEntityEvidenceAliases } from "./crypto-entity-registry";

export type BrainAnswerQuality = "complete" | "planning" | "generic_meta" | "requirements_incomplete";

export type BrainAnswerCoverage = {
  quality: BrainAnswerQuality;
  complete: boolean;
  missingRequirements: string[];
};

const MAX_CARRY_FORWARD_UNITS = 3;
const META_ANSWER_RE = /^(?:comparing|these\s+(?:items|protocols|chains|tokens)|there\s+are\s+(?:several|many)|this\s+(?:comparison|analysis)|comparing\b)[\s\S]{0,260}\b(?:requires|involves|covers|differs?\s+across|examining|considering)\b/i;

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function matchesBoundary(text: string, term: string): boolean {
  const haystack = ` ${normalize(text)} `;
  const needle = normalize(term);
  return !!needle && haystack.includes(` ${needle} `);
}

function matchesRequiredEntity(text: string, subject: QuerySubjectConstraint): boolean {
  const aliases = [...new Set([subject.canonical, subject.text, ...getEntityEvidenceAliases(subject.canonical)])];
  return aliases.some((alias) => matchesBoundary(text, alias));
}

function answerUnits(answer: string): string[] {
  return answer
    .split(/\n\s*\n|(?<=[.!?])\s+/u)
    .map((unit) => unit.trim())
    .filter(Boolean);
}

function coveredAspects(text: string, aspects: RequestedAspectConstraint[]): Set<string> {
  return new Set(aspects.filter((aspect) => matchesRequestedAspect(text, aspect)).map((aspect) => aspect.key));
}

function isPlanningAnswer(answer: string): boolean {
  return !answer.trim() || /^(?:i\s+will|i['’]?ll|i\s+can|let\s+me|this\s+(?:analysis|answer|response)\s+will|the\s+(?:following\s+)?answer\s+will|saya\s+(?:akan|sedang)|mohon\s+tunggu|gathering\s+information|searching\s+for)\b/i.test(answer.trim());
}

export function evaluateBrainAnswerCoverage(
  answer: string | null | undefined,
  requirements: QueryRequirements,
): BrainAnswerCoverage {
  const value = typeof answer === "string" ? answer.trim() : "";
  if (isPlanningAnswer(value)) return { quality: "planning", complete: false, missingRequirements: [] };

  const units = answerUnits(value);
  const aspects = requirements.requestedAspects;
  const subjects = requirements.explicitSubjects.filter((subject) => subject.required);
  const genericMeta = META_ANSWER_RE.test(value) && units.length <= 2;

  if (requirements.comparisonLike && subjects.length >= 2) {
    const coveredCells = new Set<string>();
    let activeSubject: QuerySubjectConstraint | null = null;
    let carryUnits = 0;

    for (const unit of units) {
      const mentioned = subjects.filter((subject) => matchesRequiredEntity(unit, subject));
      if (mentioned.length > 0) {
        activeSubject = mentioned[mentioned.length - 1];
        carryUnits = 0;
      } else if (activeSubject && carryUnits >= MAX_CARRY_FORWARD_UNITS) {
        activeSubject = null;
      }

      if (!activeSubject) continue;
      for (const aspect of aspects) {
        if (matchesRequestedAspect(unit, aspect)) coveredCells.add(`${activeSubject.canonical}:${aspect.key}`);
      }
      carryUnits += 1;
    }

    const missingRequirements = subjects.flatMap((subject) => aspects
      .filter((aspect) => !coveredCells.has(`${subject.canonical}:${aspect.key}`))
      .map((aspect) => `${subject.canonical}:${aspect.key}`));
    if (missingRequirements.length > 0 || genericMeta) {
      return { quality: genericMeta ? "generic_meta" : "requirements_incomplete", complete: false, missingRequirements };
    }
    return { quality: "complete", complete: true, missingRequirements: [] };
  }

  const covered = new Set(units.flatMap((unit) => [...coveredAspects(unit, aspects)]));
  const missingRequirements = aspects.filter((aspect) => !covered.has(aspect.key)).map((aspect) => aspect.key);
  if (missingRequirements.length > 0 || genericMeta) {
    return { quality: genericMeta ? "generic_meta" : "requirements_incomplete", complete: false, missingRequirements };
  }
  return { quality: "complete", complete: true, missingRequirements: [] };
}

export function evaluateBrainAnswer(answer: string | null | undefined, originalGoal: string): BrainAnswerCoverage {
  return evaluateBrainAnswerCoverage(answer, extractQueryRequirements(originalGoal));
}
