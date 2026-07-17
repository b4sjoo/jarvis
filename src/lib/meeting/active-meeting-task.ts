import type {
  ActiveInterviewChild as RuntimeActiveInterviewChild,
  ActiveInterviewParent,
  ActiveScreenTask,
  InterviewPlaybookPhase,
  InterviewSubtaskIntent,
  ProjectBinding,
  ScreenCaptureTarget,
  ScreenObservation,
  ScreenQuestionType,
  SelectedInterviewPlaybook,
  TaskAskFrame,
  TaskTopicDomain,
  WhiteboardArtifact,
} from "./types";
import {
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
} from "./task-taxonomy.js";

export type ActiveMeetingTaskSource = "screen" | "voice" | "mixed";

export interface ActiveMeetingTask {
  id: string;
  source: ActiveMeetingTaskSource;
  parent: ActiveMeetingParent;
  child?: ActiveMeetingChild;
  screen?: ActiveMeetingScreenContext;
  divergence?: ActiveMeetingTaskDivergence;
}

export interface ActiveMeetingParent {
  id: string;
  questionType: ScreenQuestionType;
  topic: string;
  playbook?: SelectedInterviewPlaybook;
  playbookPhase: InterviewPlaybookPhase;
  phaseProgress: Record<string, boolean>;
  projectBinding?: ProjectBinding;
  supportedFactAnchors: string[];
  latestUsefulAnswer?: string;
  previousUsefulAnswer?: string;
  whiteboardArtifact?: WhiteboardArtifact;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  startTurnId?: string;
  startObservationId?: string;
  revisions?: number;
}

export interface ActiveMeetingChild {
  id: string;
  createdAt: number;
  updatedAt: number;
  questionType: ScreenQuestionType;
  relation: "child-probe";
  intent: InterviewSubtaskIntent;
  question: string;
  compactSummary?: string;
  artifactId?: string;
  basedOnTurnIds: string[];
  basedOnObservationIds: string[];
}

export interface ActiveMeetingScreenContext {
  activeScreenTaskId: string;
  observationId: string;
  basedOnObservationId: string;
  captureTarget?: ScreenCaptureTarget;
  language?: string;
  question?: string;
  askFrame?: TaskAskFrame;
  topicDomain?: TaskTopicDomain;
  projectAnchor?: string;
  classifierConfidence?: number;
  latestScreenAnswer?: string;
  content?: string;
}

export interface ActiveMeetingTaskDivergence {
  reason: "question-type-mismatch" | "screen-observation-mismatch";
  screenTaskId?: string;
  interviewParentId?: string;
  screenQuestionType?: ScreenQuestionType;
  parentQuestionType?: ScreenQuestionType;
}

export interface ActiveMeetingTaskIdentityResolution {
  taskId?: string;
  parentTaskId?: string;
  childTaskId?: string;
  taskSource?: ActiveMeetingTaskSource;
}

export function buildActiveMeetingTask(input: {
  activeScreenTask?: ActiveScreenTask;
  activeInterviewTask?: ActiveInterviewParent;
  latestObservation?: ScreenObservation;
}): ActiveMeetingTask | undefined {
  const { activeScreenTask, activeInterviewTask, latestObservation } = input;

  if (!activeScreenTask && !activeInterviewTask) return undefined;

  const screen = activeScreenTask
    ? buildScreenContext(activeScreenTask, latestObservation)
    : undefined;

  const parent = activeInterviewTask
    ? buildParentFromInterviewTask(activeInterviewTask)
    : activeScreenTask
      ? buildParentFromScreenTask(activeScreenTask)
      : undefined;

  if (!parent) return undefined;

  const source = computeTaskSource(activeScreenTask, activeInterviewTask);
  const child = activeInterviewTask?.child
    ? buildChild(activeInterviewTask.child)
    : undefined;
  const divergence = detectDivergence(activeScreenTask, parent);

  return {
    id: parent.id,
    source,
    parent,
    child,
    screen,
    divergence,
  };
}

export function getActiveMeetingTaskId(task: ActiveMeetingTask | undefined) {
  return task?.id;
}

export function resolveActiveMeetingTaskIdentity(input: {
  metadata?: Record<string, unknown>;
  activeMeetingTask?: ActiveMeetingTask;
  explicitTaskId?: string;
}): ActiveMeetingTaskIdentityResolution {
  const { metadata, activeMeetingTask, explicitTaskId } = input;
  const activeMeetingTaskId = readMetadataString(
    metadata,
    "activeMeetingTaskId"
  );
  const activeMeetingParentId = readMetadataString(
    metadata,
    "activeMeetingParentId"
  );
  const activeMeetingChildId = readMetadataString(
    metadata,
    "activeMeetingChildId"
  );
  const legacyInterviewParentId = readMetadataString(
    metadata,
    "activeInterviewParentId"
  );
  const legacyInterviewChildId = readMetadataString(
    metadata,
    "activeInterviewChildId"
  );
  const legacyScreenTaskId = readMetadataString(metadata, "activeScreenTaskId");
  const metadataTaskId =
    activeMeetingTaskId ??
    activeMeetingParentId ??
    readMetadataString(metadata, "taskId") ??
    explicitTaskId ??
    legacyInterviewParentId ??
    legacyScreenTaskId;
  const metadataParentTaskId =
    activeMeetingParentId ??
    activeMeetingTaskId ??
    legacyInterviewParentId ??
    legacyScreenTaskId;

  return {
    taskId: metadataTaskId ?? activeMeetingTask?.id,
    parentTaskId: metadataParentTaskId ?? activeMeetingTask?.parent.id,
    childTaskId:
      activeMeetingChildId ??
      legacyInterviewChildId ??
      activeMeetingTask?.child?.id,
    taskSource:
      readMetadataTaskSource(metadata, "activeMeetingTaskSource") ??
      activeMeetingTask?.source,
  };
}

export function collectActiveMeetingTaskIdentityIds(input: {
  metadata?: Record<string, unknown>;
  activeMeetingTask?: ActiveMeetingTask;
  explicitTaskId?: string;
}) {
  const identity = resolveActiveMeetingTaskIdentity(input);
  return uniqueStrings([
    input.explicitTaskId,
    readMetadataString(input.metadata, "taskId"),
    identity.taskId,
    identity.parentTaskId,
    identity.childTaskId,
    readMetadataString(input.metadata, "activeScreenTaskId"),
    readMetadataString(input.metadata, "activeInterviewParentId"),
    readMetadataString(input.metadata, "activeInterviewChildId"),
  ]);
}

export function getActiveMeetingParentQuestionType(
  task: ActiveMeetingTask | undefined
) {
  return task?.parent.questionType;
}

export function getActiveMeetingTaskTraceMetadata(
  task: ActiveMeetingTask | undefined
): Record<string, unknown> {
  if (!task) return {};

  return {
    activeMeetingTaskId: task.id,
    activeMeetingTaskSource: task.source,
    activeMeetingParentId: task.parent.id,
    activeMeetingParentQuestionType: task.parent.questionType,
    activeMeetingParentPhase: task.parent.playbookPhase,
    activeMeetingProjectBindingId: task.parent.projectBinding?.projectId,
    activeMeetingProjectBindingName: task.parent.projectBinding?.projectName,
    activeMeetingProjectBindingEntryId:
      task.parent.projectBinding?.primaryEntryId,
    activeMeetingProjectBindingSource: task.parent.projectBinding?.source,
    activeMeetingProjectBindingConfidence:
      task.parent.projectBinding?.confidence,
    activeMeetingProjectBindingRevision: task.parent.projectBinding?.revision,
    activeMeetingChildId: task.child?.id,
    activeMeetingChildQuestionType: task.child?.questionType,
    activeMeetingChildIntent: task.child?.intent,
    activeMeetingScreenTaskId: task.screen?.activeScreenTaskId,
    activeMeetingScreenAskFrame: task.screen?.askFrame,
    activeMeetingScreenTopicDomain: task.screen?.topicDomain,
    activeMeetingScreenProjectAnchor: task.screen?.projectAnchor,
    activeMeetingScreenClassifierConfidence: task.screen?.classifierConfidence,
    activeMeetingTaskDivergence: task.divergence?.reason,
    whiteboardArtifactId: task.parent.whiteboardArtifact?.id,
    whiteboardArtifactRevision: task.parent.whiteboardArtifact?.revision,
    whiteboardArtifactDomainTrack:
      task.parent.whiteboardArtifact?.domainTrack,
  };
}

export function formatActiveMeetingTaskForPrompt(
  task: ActiveMeetingTask | undefined
) {
  if (!task) return "No active meeting task.";

  return [
    `Task id: ${task.id}`,
    `Source: ${task.source}`,
    "Parent:",
    `- Parent id: ${task.parent.id}`,
    `- Question type: ${task.parent.questionType}`,
    `- Topic: ${task.parent.topic || "unknown"}`,
    `- Playbook phase: ${task.parent.playbookPhase}`,
    task.parent.projectBinding
      ? `- Bound project: ${task.parent.projectBinding.projectName} (source=${task.parent.projectBinding.source}, confidence=${task.parent.projectBinding.confidence.toFixed(2)})`
      : undefined,
    task.parent.supportedFactAnchors.length
      ? `- Supported fact anchors: ${task.parent.supportedFactAnchors.join(", ")}`
      : undefined,
    task.child
      ? [
          "Active child probe:",
          `- Child id: ${task.child.id}`,
          `- Question type: ${task.child.questionType}`,
          `- Intent: ${task.child.intent}`,
          `- Question: ${task.child.question}`,
          task.child.compactSummary
            ? `- Compact summary: ${task.child.compactSummary}`
            : undefined,
        ]
          .filter(Boolean)
          .join("\n")
      : undefined,
    task.screen
      ? [
          "Screen context:",
          `- Screen task id: ${task.screen.activeScreenTaskId}`,
          `- Observation id: ${task.screen.observationId}`,
          task.screen.language ? `- Language: ${task.screen.language}` : undefined,
          task.screen.question ? `- Question: ${task.screen.question}` : undefined,
          task.screen.askFrame
            ? `- Ask frame: ${task.screen.askFrame}`
            : undefined,
          task.screen.topicDomain
            ? `- Topic domain: ${task.screen.topicDomain}`
            : undefined,
          task.screen.projectAnchor
            ? `- Project anchor: ${task.screen.projectAnchor}`
            : undefined,
          typeof task.screen.classifierConfidence === "number"
            ? `- Classifier confidence: ${task.screen.classifierConfidence}`
            : undefined,
          task.screen.captureTarget?.appName
            ? `- App: ${task.screen.captureTarget.appName}`
            : undefined,
          task.screen.captureTarget?.title
            ? `- Title: ${task.screen.captureTarget.title}`
            : undefined,
          task.screen.latestScreenAnswer
            ? `- Latest screen answer: ${task.screen.latestScreenAnswer.slice(0, 900)}`
            : undefined,
        ]
          .filter(Boolean)
          .join("\n")
      : undefined,
    task.parent.latestUsefulAnswer
      ? `Latest useful answer summary: ${task.parent.latestUsefulAnswer.slice(0, 900)}`
      : undefined,
    task.parent.whiteboardArtifact
      ? [
          "Active whiteboard artifact:",
          `- Artifact id: ${task.parent.whiteboardArtifact.id}`,
          `- Revision: ${task.parent.whiteboardArtifact.revision}`,
          `- Domain track: ${task.parent.whiteboardArtifact.domainTrack}`,
          task.parent.whiteboardArtifact.selectedOverlayIds.length
            ? `- Selected overlays: ${task.parent.whiteboardArtifact.selectedOverlayIds.join(", ")}`
            : undefined,
          `- Summary: ${task.parent.whiteboardArtifact.summary.slice(0, 700)}`,
        ]
          .filter(Boolean)
          .join("\n")
      : undefined,
    task.parent.previousUsefulAnswer
      ? `Previous useful answer summary: ${task.parent.previousUsefulAnswer.slice(0, 600)}`
      : undefined,
    task.divergence
      ? `State divergence: ${JSON.stringify(task.divergence)}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatActiveMeetingTaskForRecording(
  task: ActiveMeetingTask
) {
  return {
    id: task.id,
    source: task.source,
    parent: {
      ...task.parent,
      phaseProgress: { ...task.parent.phaseProgress },
      supportedFactAnchors: [...task.parent.supportedFactAnchors],
      projectBinding: task.parent.projectBinding
        ? {
            ...task.parent.projectBinding,
            evidenceEntryIds: [...task.parent.projectBinding.evidenceEntryIds],
          }
        : undefined,
    },
    child: task.child ? { ...task.child } : undefined,
    screen: task.screen ? { ...task.screen } : undefined,
    divergence: task.divergence ? { ...task.divergence } : undefined,
  };
}

export function getActiveMeetingTaskFocusSummary(
  task: ActiveMeetingTask | undefined
) {
  if (!task) return undefined;

  return {
    id: task.id,
    source: task.source,
    questionType: task.parent.questionType,
    topic: task.parent.topic,
    playbookPhase: task.parent.playbookPhase,
    hasScreenContext: Boolean(task.screen),
    child: task.child
      ? {
          id: task.child.id,
          questionType: task.child.questionType,
          intent: task.child.intent,
          question: task.child.question,
        }
      : undefined,
  };
}

function buildParentFromInterviewTask(
  task: ActiveInterviewParent
): ActiveMeetingParent {
  return {
    id: task.id,
    questionType: task.stableKind,
    topic: task.topic,
    playbook: task.playbook ? { ...task.playbook } : undefined,
    playbookPhase: task.playbookPhase,
    phaseProgress: { ...task.phaseProgress },
    supportedFactAnchors: [...task.supportedFactAnchors],
    projectBinding: task.projectBinding
      ? {
          ...task.projectBinding,
          evidenceEntryIds: [...task.projectBinding.evidenceEntryIds],
        }
      : undefined,
    latestUsefulAnswer: task.latestUsefulAnswer,
    previousUsefulAnswer: task.previousUsefulAnswer,
    whiteboardArtifact: task.whiteboardArtifact
      ? { ...task.whiteboardArtifact }
      : undefined,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    expiresAt: task.expiresAt,
    startTurnId: task.startTurnId,
    startObservationId: task.startObservationId,
    revisions: task.revisions,
  };
}

function buildParentFromScreenTask(task: ActiveScreenTask): ActiveMeetingParent {
  const canonicalKind = normalizeCanonicalQuestionType(task.kind);
  const questionType: ScreenQuestionType =
    canonicalKind && isParentCanonicalQuestionType(canonicalKind)
      ? canonicalKind
      : task.kind;

  return {
    id: task.id,
    questionType,
    topic: task.question || task.classifier?.projectAnchor || "screen task",
    playbook: task.playbook ? { ...task.playbook } : undefined,
    playbookPhase: task.playbook?.phase ?? "follow_up",
    phaseProgress: {},
    supportedFactAnchors: [],
    latestUsefulAnswer: task.content,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    expiresAt: task.expiresAt,
    startObservationId: task.basedOnObservationId,
    revisions: 0,
  };
}

function buildChild(task: RuntimeActiveInterviewChild): ActiveMeetingChild {
  return {
    ...task,
    basedOnTurnIds: [...task.basedOnTurnIds],
    basedOnObservationIds: [...task.basedOnObservationIds],
  };
}

function buildScreenContext(
  task: ActiveScreenTask,
  latestObservation: ScreenObservation | undefined
): ActiveMeetingScreenContext {
  return {
    activeScreenTaskId: task.id,
    observationId: task.observationId,
    basedOnObservationId: task.basedOnObservationId,
    captureTarget:
      latestObservation?.id === task.observationId
        ? latestObservation.captureTarget
        : undefined,
    language: task.language,
    question: task.question,
    askFrame: task.classifier?.askFrame,
    topicDomain: task.classifier?.topicDomain,
    projectAnchor: task.classifier?.projectAnchor,
    classifierConfidence: task.classifier?.confidence,
    latestScreenAnswer: task.content,
    content: task.content,
  };
}

function computeTaskSource(
  activeScreenTask: ActiveScreenTask | undefined,
  activeInterviewTask: ActiveInterviewParent | undefined
): ActiveMeetingTaskSource {
  if (activeScreenTask && activeInterviewTask) {
    if (activeInterviewTask.source === "voice") return "mixed";
    return activeScreenTask.basedOnTurnIds.length ? "mixed" : "screen";
  }
  if (activeScreenTask) return "screen";
  return "voice";
}

function detectDivergence(
  activeScreenTask: ActiveScreenTask | undefined,
  parent: ActiveMeetingParent
): ActiveMeetingTaskDivergence | undefined {
  if (!activeScreenTask) return undefined;

  const screenQuestionType = normalizeCanonicalQuestionType(activeScreenTask.kind);
  const parentQuestionType = normalizeCanonicalQuestionType(parent.questionType);
  if (
    screenQuestionType &&
    parentQuestionType &&
    screenQuestionType !== parentQuestionType
  ) {
    return {
      reason: "question-type-mismatch",
      screenTaskId: activeScreenTask.id,
      interviewParentId: parent.id,
      screenQuestionType,
      parentQuestionType,
    };
  }

  if (
    parent.startObservationId &&
    activeScreenTask.basedOnObservationId &&
    parent.startObservationId !== activeScreenTask.basedOnObservationId
  ) {
    return {
      reason: "screen-observation-mismatch",
      screenTaskId: activeScreenTask.id,
      interviewParentId: parent.id,
    };
  }

  return undefined;
}

function readMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string
) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readMetadataTaskSource(
  metadata: Record<string, unknown> | undefined,
  key: string
): ActiveMeetingTaskSource | undefined {
  const value = readMetadataString(metadata, key);
  return value === "screen" || value === "voice" || value === "mixed"
    ? value
    : undefined;
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value)))
  );
}
