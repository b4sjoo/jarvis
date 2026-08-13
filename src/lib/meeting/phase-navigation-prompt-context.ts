import { formatActiveMeetingTaskForPrompt } from "./active-meeting-task.js";
import { parseMeetingAnswer } from "./meeting-answer.js";
import type {
  AdvisorEvidencePacket,
  AdvisorPromptContext,
  MeetingResponseActionMode,
} from "./types.js";

const MAX_CURRENT_QUESTION_CHARS = 2_400;
const MAX_SCREEN_QUESTION_CHARS = 2_400;
const MAX_MEMORY_CONTEXT_CHARS = 6_000;
const MAX_GLOSSARY_CHARS = 800;
const MAX_ANSWER_CHARS = 1_000;
const MAX_APPROACH_CHARS = 1_400;
const MAX_CODE_CHARS = 2_800;
const MAX_COMPLEXITY_CHARS = 500;
const MAX_WHITEBOARD_CHARS = 2_000;
const MAX_CLARIFYING_CHARS = 600;

export type PhaseNavigationAction = Extract<
  MeetingResponseActionMode,
  "next-phase" | "previous-phase"
>;

export interface PhaseNavigationPromptMetrics {
  action: PhaseNavigationAction;
  compactionApplied: boolean;
  originalContextChars: number;
  compactedContextChars: number;
  reductionChars: number;
  reductionRatio: number;
  transcriptChars: number;
  screenContextChars: number;
  activeTaskChars: number;
  playbookChars: number;
  memoryChars: number;
  evidencePacketChars: number;
  artifactContextChars: number;
  currentSuggestionChars: number;
}

export interface PhaseNavigationPromptComposition {
  promptContext: AdvisorPromptContext;
  currentSuggestion?: string;
  metrics: PhaseNavigationPromptMetrics;
}

export function isPhaseNavigationAction(
  action: MeetingResponseActionMode | undefined
): action is PhaseNavigationAction {
  return action === "next-phase" || action === "previous-phase";
}

export function composePhaseNavigationPromptContext(input: {
  action: PhaseNavigationAction;
  promptContext: AdvisorPromptContext;
  currentSuggestion?: string;
}): PhaseNavigationPromptComposition {
  const originalMetrics = measurePromptContext(
    input.promptContext,
    input.currentSuggestion
  );
  const currentQuestion = resolveCurrentQuestion(input.promptContext);
  const screenQuestion = input.promptContext.activeMeetingTask?.screen?.question;
  const compactedSuggestion = compactMeetingSuggestion(input.currentSuggestion);
  const compactedTask = compactActiveMeetingTask(input.promptContext);
  const compactedEvidencePacket = compactEvidencePacket(
    input.promptContext.advisorEvidencePacket
  );
  const promptContext: AdvisorPromptContext = {
    ...input.promptContext,
    transcript:
      currentQuestion && !screenQuestion
        ? `Them: ${currentQuestion}`
        : "",
    advisorPromptSourceTurnIds:
      input.promptContext.currentQuestionProjection?.sourceTurnIds ??
      input.promptContext.advisorEvidencePacket?.currentQuestion?.sourceTurnIds ??
      [],
    screenContext: screenQuestion
      ? boundText(screenQuestion, MAX_SCREEN_QUESTION_CHARS)
      : "",
    responseOnlyParentReadContext: undefined,
    taskRuntime: {
      revision: input.promptContext.taskRuntime.revision,
      lastMutation: input.promptContext.taskRuntime.lastMutation,
    },
    activeMeetingTask: compactedTask,
    rollingSummary: "",
    userProfileContext: "",
    glossaryText: boundText(
      input.promptContext.glossaryText,
      MAX_GLOSSARY_CHARS
    ),
    memoryContext: boundText(
      input.promptContext.memoryContext,
      MAX_MEMORY_CONTEXT_CHARS
    ),
    openingRoute: undefined,
    confirmedMeFacts: undefined,
    latestTurn: screenQuestion
      ? undefined
      : input.promptContext.latestTurn
        ? {
            ...input.promptContext.latestTurn,
            text: currentQuestion || input.promptContext.latestTurn.text,
          }
        : undefined,
    advisorEvidencePacket: compactedEvidencePacket,
  };
  const compactedMetrics = measurePromptContext(
    promptContext,
    compactedSuggestion
  );
  const reductionChars = Math.max(
    0,
    originalMetrics.totalChars - compactedMetrics.totalChars
  );

  return {
    promptContext,
    currentSuggestion: compactedSuggestion,
    metrics: {
      action: input.action,
      compactionApplied: reductionChars > 0,
      originalContextChars: originalMetrics.totalChars,
      compactedContextChars: compactedMetrics.totalChars,
      reductionChars,
      reductionRatio:
        originalMetrics.totalChars > 0
          ? Number((reductionChars / originalMetrics.totalChars).toFixed(4))
          : 0,
      transcriptChars: promptContext.transcript.length,
      screenContextChars: promptContext.screenContext.length,
      activeTaskChars: compactedMetrics.activeTaskChars,
      playbookChars: compactedMetrics.playbookChars,
      memoryChars: promptContext.memoryContext?.length ?? 0,
      evidencePacketChars: compactedMetrics.evidencePacketChars,
      artifactContextChars: compactedMetrics.artifactContextChars,
      currentSuggestionChars: compactedSuggestion?.length ?? 0,
    },
  };
}

export function formatPhaseNavigationPromptMetricsForTrace(
  metrics: PhaseNavigationPromptMetrics
): Record<string, unknown> {
  return {
    phaseNavigationPromptAction: metrics.action,
    phaseNavigationPromptCompactionApplied: metrics.compactionApplied,
    phaseNavigationPromptOriginalContextChars: metrics.originalContextChars,
    phaseNavigationPromptCompactedContextChars: metrics.compactedContextChars,
    phaseNavigationPromptReductionChars: metrics.reductionChars,
    phaseNavigationPromptReductionRatio: metrics.reductionRatio,
    advisorPromptTranscriptChars: metrics.transcriptChars,
    advisorPromptScreenContextChars: metrics.screenContextChars,
    advisorPromptActiveTaskChars: metrics.activeTaskChars,
    advisorPromptPlaybookChars: metrics.playbookChars,
    advisorPromptMemoryChars: metrics.memoryChars,
    advisorPromptEvidencePacketChars: metrics.evidencePacketChars,
    advisorPromptArtifactContextChars: metrics.artifactContextChars,
    advisorPromptCurrentSuggestionChars: metrics.currentSuggestionChars,
  };
}

export function measureTaggedPromptSectionChars(prompt: string, tag: string) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `<${escapedTag}>([\\s\\S]*?)<\\/${escapedTag}>`,
    "i"
  ).exec(prompt);
  return match?.[1]?.length ?? 0;
}

function resolveCurrentQuestion(context: AdvisorPromptContext) {
  return boundText(
    context.currentQuestionProjection?.answerFocusText ||
      context.advisorEvidencePacket?.currentQuestion?.text ||
      context.activeMeetingTask?.screen?.question ||
      context.latestTurn?.text ||
      context.transcript,
    MAX_CURRENT_QUESTION_CHARS
  );
}

function compactActiveMeetingTask(context: AdvisorPromptContext) {
  const task = context.activeMeetingTask;
  if (!task) return undefined;

  return {
    ...task,
    parent: {
      ...task.parent,
      topic: boundText(task.parent.topic, 800),
      phaseProgress: { ...task.parent.phaseProgress },
      supportedFactAnchors: [...task.parent.supportedFactAnchors],
      latestUsefulAnswer: undefined,
      previousUsefulAnswer: undefined,
      whiteboardArtifact: task.parent.whiteboardArtifact
        ? {
            ...task.parent.whiteboardArtifact,
            content: boundText(
              task.parent.whiteboardArtifact.content,
              MAX_WHITEBOARD_CHARS
            ),
            summary: boundText(task.parent.whiteboardArtifact.summary, 900),
          }
        : undefined,
    },
    child: task.child
      ? {
          ...task.child,
          question: boundText(task.child.question, 800),
          compactSummary: boundText(task.child.compactSummary, 500),
        }
      : undefined,
    screen: task.screen
      ? {
          ...task.screen,
          question: boundText(task.screen.question, MAX_SCREEN_QUESTION_CHARS),
          latestScreenAnswer: undefined,
          content: undefined,
        }
      : undefined,
  };
}

function compactEvidencePacket(
  packet: AdvisorEvidencePacket | undefined
): AdvisorEvidencePacket | undefined {
  if (!packet) return undefined;
  const personalized = packet.preparation.personalizedGuidance;

  return {
    ...packet,
    currentQuestion: packet.currentQuestion
      ? {
          ...packet.currentQuestion,
          text: boundText(
            packet.currentQuestion.text,
            MAX_CURRENT_QUESTION_CHARS
          ),
        }
      : undefined,
    continuity: packet.continuity
      ? {
          ...packet.continuity,
          capsule: boundText(packet.continuity.capsule, 900),
          sourceTurnIds: [...packet.continuity.sourceTurnIds],
        }
      : undefined,
    preparation: {
      ...packet.preparation,
      guidanceHints: packet.preparation.guidanceHints
        .slice(0, 4)
        .map((hint) => boundText(hint, 400)),
      activatedFactIds: [...packet.preparation.activatedFactIds],
      personalizedGuidance: personalized
        ? {
            factEvidence: personalized.factEvidence.slice(0, 8).map((fact) => ({
              ...fact,
              content: boundText(fact.content, 500),
              prohibitedWording: fact.prohibitedWording.slice(0, 4),
              sourceIds: [...fact.sourceIds],
            })),
            openingItems: [],
            narratives: [],
            playbookOverlay: personalized.playbookOverlay,
          }
        : undefined,
    },
    generatedGuidance: undefined,
    generatedContinuity: undefined,
    retrievalHints: packet.retrievalHints.slice(0, 6).map((hint) => ({
      ...hint,
      text: boundText(hint.text, 500),
    })),
  };
}

function compactMeetingSuggestion(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = parseMeetingAnswer(trimmed);
  const sections = parsed.sections;
  const compacted = [
    formatSection("中文思路", sections.chineseThinking, 800),
    formatSection("Question", sections.question, 600),
    formatSection("Answer", sections.answer, MAX_ANSWER_CHARS),
    formatSection("Approach", sections.approach, MAX_APPROACH_CHARS),
    formatSection("Code", sections.code, MAX_CODE_CHARS),
    formatSection("Complexity", sections.complexity, MAX_COMPLEXITY_CHARS),
    formatSection("Whiteboard", sections.whiteboard, MAX_WHITEBOARD_CHARS),
    formatSection(
      "Clarifying question",
      sections.clarifyingQuestion,
      MAX_CLARIFYING_CHARS
    ),
  ].filter(Boolean);

  return compacted.length
    ? compacted.join("\n\n")
    : boundText(trimmed, 4_000);
}

function formatSection(label: string, value: string | undefined, maxChars: number) {
  const bounded = boundText(value, maxChars);
  return bounded ? `${label}:\n${bounded}` : undefined;
}

function measurePromptContext(
  context: AdvisorPromptContext,
  currentSuggestion: string | undefined
) {
  const activeTaskChars = formatActiveMeetingTaskForPrompt(
    context.activeMeetingTask
  ).length;
  const playbookChars = serializedChars({
    playbook: context.interviewPlaybook,
    phase: context.playbookPhaseDecision,
  });
  const evidencePacketChars = serializedChars(context.advisorEvidencePacket);
  const artifactContextChars = serializedChars({
    latestUsefulAnswer: context.activeMeetingTask?.parent.latestUsefulAnswer,
    previousUsefulAnswer: context.activeMeetingTask?.parent.previousUsefulAnswer,
    whiteboardArtifact: context.activeMeetingTask?.parent.whiteboardArtifact,
  });
  const totalChars = serializedChars(context) + (currentSuggestion?.length ?? 0);

  return {
    totalChars,
    activeTaskChars,
    playbookChars,
    evidencePacketChars,
    artifactContextChars,
  };
}

function serializedChars(value: unknown) {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function boundText(value: string | undefined, maxChars: number) {
  const normalized = value?.trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n[context truncated]`;
}
