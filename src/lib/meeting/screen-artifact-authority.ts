import type { AnswerArtifactSection } from "./answer-generation-lease.js";
import { normalizeCanonicalQuestionType } from "./task-taxonomy.js";
import type {
  InterviewSubtaskIntent,
  ParsedMeetingAnswer,
  ScreenQuestionType,
} from "./types.js";

export type ScreenPresentationArtifactAuthoritySource =
  | "playbook-phase"
  | "manual-screen";

export interface ScreenPresentationArtifactAuthorityDecision {
  source: ScreenPresentationArtifactAuthoritySource;
  requestedArtifacts: AnswerArtifactSection[];
  authorizedArtifacts: AnswerArtifactSection[];
  codeCandidatePresent: boolean;
  complexityCandidatePresent: boolean;
  whiteboardCandidatePresent: boolean;
  reason: string;
}

const ARTIFACT_ORDER: AnswerArtifactSection[] = [
  "answer",
  "code",
  "complexity",
  "whiteboard",
];

export function resolveScreenGenerationRequestedArtifacts(
  requiredArtifacts: readonly AnswerArtifactSection[] | undefined
): AnswerArtifactSection[] {
  const requested = new Set<AnswerArtifactSection>([
    "answer",
    ...(requiredArtifacts ?? []),
  ]);
  return ARTIFACT_ORDER.filter((artifact) => requested.has(artifact));
}

export function resolveManualScreenPlaybookSubtaskIntent(input: {
  questionType?: ScreenQuestionType;
  inferredIntent?: InterviewSubtaskIntent;
}): InterviewSubtaskIntent {
  return normalizeCanonicalQuestionType(input.questionType) === "coding"
    ? "implementation-probe"
    : input.inferredIntent ?? "unknown";
}

export function authorizeManualScreenPresentationArtifacts(input: {
  requestedArtifacts: readonly AnswerArtifactSection[];
  parsedAnswer: ParsedMeetingAnswer;
}): ScreenPresentationArtifactAuthorityDecision {
  const codeCandidatePresent = hasMeaningfulArtifact(
    input.parsedAnswer.sections.code
  );
  const complexityCandidatePresent = hasMeaningfulArtifact(
    input.parsedAnswer.sections.complexity
  );
  const whiteboardCandidatePresent = hasMeaningfulArtifact(
    input.parsedAnswer.sections.whiteboard
  );
  const requested = new Set(input.requestedArtifacts);
  const authorized = new Set<AnswerArtifactSection>(["answer"]);

  // A manual screen capture is explicit presentation authority for parsed
  // coding artifacts. It does not grant task, prompt, or memory ownership.
  if (codeCandidatePresent) authorized.add("code");
  if (complexityCandidatePresent) authorized.add("complexity");
  if (requested.has("whiteboard") && whiteboardCandidatePresent) {
    authorized.add("whiteboard");
  }

  return {
    source: "manual-screen",
    requestedArtifacts: resolveScreenGenerationRequestedArtifacts(
      input.requestedArtifacts
    ),
    authorizedArtifacts: ARTIFACT_ORDER.filter((artifact) =>
      authorized.has(artifact)
    ),
    codeCandidatePresent,
    complexityCandidatePresent,
    whiteboardCandidatePresent,
    reason: [
      "manual-screen-result",
      codeCandidatePresent ? "code-present" : "code-empty-preserve",
      complexityCandidatePresent
        ? "complexity-present"
        : "complexity-empty-preserve",
      requested.has("whiteboard")
        ? "whiteboard-phase-requested"
        : "whiteboard-not-requested",
    ].join("; "),
  };
}

export function formatScreenPresentationArtifactAuthorityForTrace(
  decision: ScreenPresentationArtifactAuthorityDecision
) {
  const requested = new Set(decision.requestedArtifacts);
  const parsedArtifacts = [
    "answer",
    decision.codeCandidatePresent ? "code" : undefined,
    decision.complexityCandidatePresent ? "complexity" : undefined,
    decision.whiteboardCandidatePresent ? "whiteboard" : undefined,
  ].filter((artifact): artifact is AnswerArtifactSection => Boolean(artifact));
  const contractMismatchReasons = parsedArtifacts
    .filter((artifact) => artifact !== "answer" && !requested.has(artifact))
    .map((artifact) => `${artifact}:not-requested-by-playbook`);
  const artifactRefreshAuthorized =
    decision.codeCandidatePresent || decision.complexityCandidatePresent;
  return {
    screenArtifactAuthoritySource: decision.source,
    screenArtifactAuthorityAuthorized: artifactRefreshAuthorized,
    screenRequestedArtifacts: decision.requestedArtifacts,
    generationRequestedArtifacts: decision.requestedArtifacts,
    parsedArtifacts,
    screenPresentationAuthorizedArtifacts: decision.authorizedArtifacts,
    screenAuthorizedArtifacts: decision.authorizedArtifacts,
    screenCodeCandidatePresent: decision.codeCandidatePresent,
    screenComplexityCandidatePresent:
      decision.complexityCandidatePresent,
    screenWhiteboardCandidatePresent: decision.whiteboardCandidatePresent,
    screenArtifactAuthorityReason: decision.reason,
    playbookArtifactContractMismatch:
      contractMismatchReasons.length > 0,
    playbookArtifactContractMismatchReasons: contractMismatchReasons,
    artifactCacheDisposition: artifactRefreshAuthorized
      ? "replaced"
      : "preserved",
  };
}

function hasMeaningfulArtifact(value: string | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return Boolean(
    normalized &&
      normalized !== "-" &&
      normalized !== "none" &&
      normalized !== "n/a"
  );
}
