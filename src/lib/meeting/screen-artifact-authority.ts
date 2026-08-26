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

export function resolveManualScreenGenerationRequestedArtifacts(input: {
  requiredArtifacts: readonly AnswerArtifactSection[] | undefined;
  questionType?: ScreenQuestionType;
  boundVoicePrimaryAsk: boolean;
  primaryAskIntent: InterviewSubtaskIntent;
}): AnswerArtifactSection[] {
  const phaseArtifacts = resolveScreenGenerationRequestedArtifacts(
    input.requiredArtifacts
  );
  const questionType = normalizeCanonicalQuestionType(input.questionType);
  if (
    !input.boundVoicePrimaryAsk ||
    questionType !== "coding"
  ) {
    return phaseArtifacts;
  }

  if (input.primaryAskIntent === "implementation-probe") {
    return ["answer", "code", "complexity"];
  }
  if (input.primaryAskIntent === "complexity-probe") {
    return ["answer", "complexity"];
  }
  return ["answer"];
}

export function resolveManualScreenPlaybookSubtaskIntent(input: {
  questionType?: ScreenQuestionType;
  inferredIntent?: InterviewSubtaskIntent;
  boundVoicePrimaryAsk?: boolean;
}): InterviewSubtaskIntent {
  return input.inferredIntent ?? "unknown";
}

export function authorizeManualScreenPresentationArtifacts(input: {
  requestedArtifacts: readonly AnswerArtifactSection[];
  parsedAnswer: ParsedMeetingAnswer;
  boundVoicePrimaryAsk?: boolean;
  primaryAskIntent?: InterviewSubtaskIntent;
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

  // Parsed sections are candidate availability, never write authority. The
  // source-owned request is settled before model generation.
  if (requested.has("code") && codeCandidatePresent) {
    authorized.add("code");
  }
  if (requested.has("complexity") && complexityCandidatePresent) {
    authorized.add("complexity");
  }
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
      input.boundVoicePrimaryAsk
        ? `voice-primary-ask:${input.primaryAskIntent ?? "unknown"}`
        : "screen-primary-ask",
      codeCandidatePresent ? "code-present" : "code-empty-preserve",
      codeCandidatePresent && !requested.has("code")
        ? "code-not-requested-by-source"
        : undefined,
      complexityCandidatePresent
        ? "complexity-present"
        : "complexity-empty-preserve",
      complexityCandidatePresent && !requested.has("complexity")
        ? "complexity-not-requested-by-source"
        : undefined,
      requested.has("whiteboard")
        ? "whiteboard-phase-requested"
        : "whiteboard-not-requested",
    ]
      .filter(Boolean)
      .join("; "),
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
    decision.authorizedArtifacts.includes("code") ||
    decision.authorizedArtifacts.includes("complexity") ||
    decision.authorizedArtifacts.includes("whiteboard");
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
