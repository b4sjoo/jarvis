import type {
  ActiveInterviewChild as RuntimeActiveInterviewChild,
  ActiveBranchPhaseState,
  ActiveInterviewParent,
  ActiveScreenTask,
  InterviewPlaybookPhase,
  InterviewSubtaskIntent,
  ParentContextHandoff,
  ParentReturnCapsule,
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
  canParentQuestionTypeOwnChild,
  canQuestionTypeCreateParent,
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
} from "./task-taxonomy.js";
import type { MeetingTaskRuntimeTransitionKind } from "./meeting-task-runtime-transition.js";

export type { MeetingTaskRuntimeTransitionKind } from "./meeting-task-runtime-transition.js";

export type ActiveMeetingTaskSource = "screen" | "voice" | "mixed";

export interface ActiveMeetingTask {
  id: string;
  runtimeRevision: number;
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
  originQuestionId?: string;
  startTurnId?: string;
  startObservationId?: string;
  latestScreenObservationId?: string;
  promptTranscriptStartTurnId?: string;
  canonicalQuestionSourceTurnIds?: string[];
  sourceQuestionUnitId?: string;
  sourceQuestionRevision?: number;
  settlementId?: string;
  parentContextHandoff?: ParentContextHandoff;
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
  latestScreenObservationId?: string;
  returnCapsule?: ParentReturnCapsule;
  phaseState?: ActiveBranchPhaseState;
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

export interface MeetingTaskRuntimeState {
  revision: number;
  parent?: ActiveInterviewParent;
  screenAttachment?: ActiveScreenTask;
  lastMutation?: MeetingTaskRuntimeMutationReceipt;
}

export interface MeetingTaskRuntimeMutationReceipt {
  id: string;
  kind: MeetingTaskRuntimeMutation["kind"];
  reason: string;
  appliedAt: number;
}

interface MeetingTaskRuntimeMutationBase {
  id: string;
  reason: string;
  expectedRevision?: number;
  appliedAt?: number;
}

export type MeetingTaskRuntimeMutation =
  | (MeetingTaskRuntimeMutationBase & {
      kind: "clear";
      scope: "all" | "parent" | "screen";
    })
  | (MeetingTaskRuntimeMutationBase & {
      kind: "expire";
      now: number;
    })
  | (MeetingTaskRuntimeMutationBase & {
      kind: "commit-transition";
      transition: MeetingTaskRuntimeTransitionKind;
      parent?: ActiveInterviewParent | null;
      screenAttachment?: ActiveScreenTask | null;
    });

export interface MeetingTaskRuntimeMutationResult {
  state: MeetingTaskRuntimeState;
  authorized: boolean;
  mutationApplied: boolean;
  reason:
    | "committed"
    | "preserved"
    | "revision-mismatch"
    | "invalid-transition"
    | "parent-type-not-allowed"
    | "child-type-not-allowed";
}

export function createMeetingTaskRuntimeState(): MeetingTaskRuntimeState {
  return { revision: 0 };
}

export function reduceMeetingTaskRuntimeMutation(input: {
  state: MeetingTaskRuntimeState;
  mutation: MeetingTaskRuntimeMutation;
}): MeetingTaskRuntimeMutationResult {
  const current = cloneMeetingTaskRuntimeState(input.state);
  const { mutation } = input;
  if (
    mutation.expectedRevision !== undefined &&
    mutation.expectedRevision !== current.revision
  ) {
    return {
      state: current,
      authorized: false,
      mutationApplied: false,
      reason: "revision-mismatch",
    };
  }

  const next = applyRuntimeMutation(current, mutation);
  if (next.rejectionReason) {
    return {
      state: current,
      authorized: false,
      mutationApplied: false,
      reason: next.rejectionReason,
    };
  }
  if (!next.changed) {
    return {
      state: current,
      authorized: true,
      mutationApplied: false,
      reason: "preserved",
    };
  }

  const appliedAt = mutation.appliedAt ?? Date.now();
  return {
    state: {
      revision: current.revision + 1,
      parent: cloneRuntimeValue(current.parent),
      screenAttachment: cloneRuntimeValue(current.screenAttachment),
      ...next.patch,
      lastMutation: {
        id: mutation.id,
        kind: mutation.kind,
        reason: mutation.reason,
        appliedAt,
      },
    },
    authorized: true,
    mutationApplied: true,
    reason: "committed",
  };
}

export function projectActiveMeetingTask(input: {
  state: MeetingTaskRuntimeState;
  latestObservation?: ScreenObservation;
}): ActiveMeetingTask | undefined {
  return buildActiveMeetingTask({
    screenAttachment: input.state.screenAttachment,
    parent: input.state.parent,
    latestObservation: input.latestObservation,
    runtimeRevision: input.state.revision,
  });
}

export function cloneMeetingTaskRuntimeState(
  state: MeetingTaskRuntimeState
): MeetingTaskRuntimeState {
  return {
    revision: state.revision,
    parent: cloneRuntimeValue(state.parent),
    screenAttachment: cloneRuntimeValue(state.screenAttachment),
    lastMutation: state.lastMutation
      ? { ...state.lastMutation }
      : undefined,
  };
}

export function buildActiveMeetingTask(input: {
  screenAttachment?: ActiveScreenTask;
  parent?: ActiveInterviewParent;
  latestObservation?: ScreenObservation;
  runtimeRevision: number;
}): ActiveMeetingTask | undefined {
  const {
    screenAttachment,
    parent: interviewParent,
    latestObservation,
    runtimeRevision,
  } = input;

  if (!screenAttachment && !interviewParent) return undefined;

  const screen = screenAttachment
    ? buildScreenContext(screenAttachment, latestObservation)
    : interviewParent
      ? buildCanonicalScreenContext(interviewParent, latestObservation)
      : undefined;

  const parent = interviewParent
    ? buildParentFromInterviewTask(interviewParent)
    : screenAttachment
      ? buildParentFromScreenTask(screenAttachment)
      : undefined;

  if (!parent) return undefined;

  const source = computeTaskSource(
    screenAttachment,
    interviewParent,
    Boolean(screen)
  );
  const child = interviewParent?.child
    ? buildChild(interviewParent.child)
    : undefined;
  const divergence = detectDivergence(screenAttachment, parent);

  return {
    id: parent.id,
    runtimeRevision,
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
    activeMeetingTaskRuntimeRevision: task.runtimeRevision,
    activeMeetingTaskSource: task.source,
    activeMeetingParentId: task.parent.id,
    activeMeetingParentRevision: task.parent.revisions,
    activeMeetingParentQuestionType: task.parent.questionType,
    activeMeetingParentPhase: task.parent.playbookPhase,
    activeMeetingParentOriginQuestionId: task.parent.originQuestionId,
    activeMeetingPromptTranscriptStartTurnId:
      task.parent.promptTranscriptStartTurnId,
    canonicalQuestionSourceTurnIds:
      task.parent.canonicalQuestionSourceTurnIds,
    activeMeetingSourceQuestionUnitId:
      task.parent.sourceQuestionUnitId,
    activeMeetingSourceQuestionRevision:
      task.parent.sourceQuestionRevision,
    activeMeetingSettlementId: task.parent.settlementId,
    activeMeetingParentHandoffSourceId:
      task.parent.parentContextHandoff?.sourceParentId,
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
    activeMeetingChildPlaybookId: task.child?.phaseState?.playbook.id,
    activeMeetingChildPhase: task.child?.phaseState?.phase,
    activeMeetingChildPhaseRevision: task.child?.phaseState?.revision,
    activeMeetingChildReturnParentId: task.child?.returnCapsule?.parentId,
    activeMeetingChildReturnPhase: task.child?.returnCapsule?.parentPhase,
    activeMeetingChildReturnProjectBindingRevision:
      task.child?.returnCapsule?.projectBindingRevision,
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
    whiteboardProvisional: task.parent.whiteboardArtifact?.provisional,
    whiteboardOpenConstraintCategories:
      task.parent.whiteboardArtifact?.openConstraintCategories,
    whiteboardRevisionReason:
      task.parent.whiteboardArtifact?.revisionReason,
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
    task.parent.parentContextHandoff
      ? formatParentContextHandoffForPrompt(task.parent.parentContextHandoff)
      : undefined,
    task.child
      ? [
          "Active child probe:",
          `- Child id: ${task.child.id}`,
          `- Question type: ${task.child.questionType}`,
          `- Intent: ${task.child.intent}`,
          `- Question: ${task.child.question}`,
          task.child.phaseState
            ? `- Playbook phase: ${task.child.phaseState.phase} (revision=${task.child.phaseState.revision})`
            : `- Playbook phase: unavailable`,
          task.child.compactSummary
            ? `- Compact summary: ${task.child.compactSummary}`
            : undefined,
          task.child.returnCapsule
            ? `- Resume target: parent=${task.child.returnCapsule.parentId}, phase=${task.child.returnCapsule.parentPhase}, projectBindingRevision=${task.child.returnCapsule.projectBindingRevision ?? "none"}`
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
          `- Provisional: ${Boolean(task.parent.whiteboardArtifact.provisional)}`,
          task.parent.whiteboardArtifact.openConstraintCategories?.length
            ? `- Open constraints: ${task.parent.whiteboardArtifact.openConstraintCategories.join(", ")}`
            : undefined,
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
    runtimeRevision: task.runtimeRevision,
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
      parentContextHandoff: cloneParentContextHandoff(
        task.parent.parentContextHandoff
      ),
    },
    child: task.child
      ? {
          ...task.child,
          basedOnTurnIds: [...task.child.basedOnTurnIds],
          basedOnObservationIds: [...task.child.basedOnObservationIds],
          returnCapsule: cloneParentReturnCapsule(
            task.child.returnCapsule
          ),
          phaseState: cloneBranchPhaseState(task.child.phaseState),
        }
      : undefined,
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
          playbookPhase: task.child.phaseState?.phase,
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
    originQuestionId: task.originQuestionId,
    startTurnId: task.startTurnId,
    startObservationId: task.startObservationId,
    latestScreenObservationId: task.latestScreenObservationId,
    promptTranscriptStartTurnId: task.promptTranscriptStartTurnId,
    canonicalQuestionSourceTurnIds: task.canonicalQuestionSourceTurnIds
      ? [...task.canonicalQuestionSourceTurnIds]
      : undefined,
    sourceQuestionUnitId: task.sourceQuestionUnitId,
    sourceQuestionRevision: task.sourceQuestionRevision,
    settlementId: task.settlementId,
    parentContextHandoff: cloneParentContextHandoff(task.parentContextHandoff),
    revisions: task.revisions,
  };
}

function formatParentContextHandoffForPrompt(handoff: ParentContextHandoff) {
  const scenario = handoff.sharedScenarioContext;
  return [
    "Bounded context inherited from the previous parent:",
    `- Source parent: ${handoff.sourceParentId}`,
    scenario.productIdentity
      ? `- Product identity: ${scenario.productIdentity}`
      : undefined,
    scenario.domainEntities?.length
      ? `- Shared domain entities: ${scenario.domainEntities.join(", ")}`
      : undefined,
    scenario.applicableScaleAssumptions?.length
      ? `- Applicable scale assumptions: ${scenario.applicableScaleAssumptions
          .map((item) =>
            item.sourceTurnId
              ? `${item.value} [source=${item.sourceTurnId}]`
              : item.value
          )
          .join("; ")}`
      : undefined,
    scenario.sharedRequirements?.length
      ? `- Shared requirements: ${scenario.sharedRequirements.join("; ")}`
      : undefined,
    `- Excluded prior context: ${handoff.excludedContextKinds.join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function cloneParentContextHandoff(
  handoff: ParentContextHandoff | undefined
): ParentContextHandoff | undefined {
  if (!handoff) return undefined;
  return {
    ...handoff,
    sharedScenarioContext: {
      ...handoff.sharedScenarioContext,
      domainEntities: handoff.sharedScenarioContext.domainEntities
        ? [...handoff.sharedScenarioContext.domainEntities]
        : undefined,
      applicableScaleAssumptions:
        handoff.sharedScenarioContext.applicableScaleAssumptions?.map((item) => ({
          ...item,
        })),
      sharedRequirements: handoff.sharedScenarioContext.sharedRequirements
        ? [...handoff.sharedScenarioContext.sharedRequirements]
        : undefined,
    },
    excludedContextKinds: [...handoff.excludedContextKinds],
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
    latestScreenObservationId: task.basedOnObservationId,
    revisions: 0,
  };
}

function buildChild(task: RuntimeActiveInterviewChild): ActiveMeetingChild {
  return {
    ...task,
    basedOnTurnIds: [...task.basedOnTurnIds],
    basedOnObservationIds: [...task.basedOnObservationIds],
    latestScreenObservationId: task.latestScreenObservationId,
    returnCapsule: cloneParentReturnCapsule(task.returnCapsule),
    phaseState: cloneBranchPhaseState(task.phaseState),
  };
}

function cloneBranchPhaseState(
  state: ActiveBranchPhaseState | undefined
): ActiveBranchPhaseState | undefined {
  if (!state) return undefined;
  return {
    ...state,
    playbook: { ...state.playbook },
    phaseProgress: { ...state.phaseProgress },
  };
}

function cloneParentReturnCapsule(
  capsule: ParentReturnCapsule | undefined
): ParentReturnCapsule | undefined {
  if (!capsule) return undefined;
  return {
    ...capsule,
    allowedFactAnchorIds: [...capsule.allowedFactAnchorIds],
    artifactCompatibility: { ...capsule.artifactCompatibility },
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

function buildCanonicalScreenContext(
  task: ActiveInterviewParent,
  observation: ScreenObservation | undefined
): ActiveMeetingScreenContext | undefined {
  const observationId =
    task.child?.latestScreenObservationId ??
    task.latestScreenObservationId;
  if (!observationId || observation?.id !== observationId) return undefined;

  return {
    activeScreenTaskId: `canonical-screen:${observationId}`,
    observationId,
    basedOnObservationId: observationId,
    captureTarget: observation.captureTarget,
    question: task.child?.question ?? task.topic,
  };
}

function computeTaskSource(
  activeScreenTask: ActiveScreenTask | undefined,
  activeInterviewTask: ActiveInterviewParent | undefined,
  hasCanonicalScreen: boolean
): ActiveMeetingTaskSource {
  if (activeScreenTask && activeInterviewTask) {
    if (activeInterviewTask.source === "voice") return "mixed";
    return activeScreenTask.basedOnTurnIds.length ? "mixed" : "screen";
  }
  if (activeScreenTask) return "screen";
  if (hasCanonicalScreen && activeInterviewTask) {
    return activeInterviewTask.source === "screen" ? "screen" : "mixed";
  }
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

function applyRuntimeMutation(
  state: MeetingTaskRuntimeState,
  mutation: MeetingTaskRuntimeMutation
): {
  changed: boolean;
  patch: Partial<MeetingTaskRuntimeState>;
  rejectionReason?: RuntimeTransitionRejectionReason;
} {
  if (mutation.kind === "commit-transition") {
    const parent =
      mutation.parent === undefined
        ? state.parent
        : mutation.parent ?? undefined;
    const screenAttachment =
      mutation.screenAttachment === undefined
        ? state.screenAttachment
        : mutation.screenAttachment ?? undefined;
    const rejectionReason = validateRuntimeTransition({
      transition: mutation.transition,
      beforeParent: state.parent,
      afterParent: parent,
      beforeScreen: state.screenAttachment,
      afterScreen: screenAttachment,
    });
    if (rejectionReason) {
      return {
        changed: false,
        patch: {},
        rejectionReason,
      };
    }
    return {
      changed:
        mutation.parent !== undefined ||
        mutation.screenAttachment !== undefined,
      patch: {
        parent: cloneRuntimeValue(parent),
        screenAttachment: cloneRuntimeValue(screenAttachment),
      },
    };
  }

  if (mutation.kind === "clear") {
    if (mutation.scope === "all") {
      return {
        changed: Boolean(state.parent || state.screenAttachment),
        patch: { parent: undefined, screenAttachment: undefined },
      };
    }
    if (mutation.scope === "parent") {
      return {
        changed: Boolean(state.parent),
        patch: { parent: undefined },
      };
    }
    return {
      changed: Boolean(
        state.screenAttachment || state.parent?.source === "screen"
      ),
      patch: {
        screenAttachment: undefined,
        parent:
          state.parent?.source === "screen"
            ? undefined
            : cloneRuntimeValue(state.parent),
      },
    };
  }

  let parent = cloneRuntimeValue(state.parent);
  let screenAttachment = cloneRuntimeValue(state.screenAttachment);
  let changed = false;
  if (
    screenAttachment?.expiresAt &&
    screenAttachment.expiresAt <= mutation.now
  ) {
    screenAttachment = undefined;
    if (parent?.source === "screen") parent = undefined;
    changed = true;
  }
  if (parent?.expiresAt && parent.expiresAt <= mutation.now) {
    parent = undefined;
    changed = true;
  }
  return {
    changed,
    patch: { parent, screenAttachment },
  };
}

type RuntimeTransitionRejectionReason =
  | "invalid-transition"
  | "parent-type-not-allowed"
  | "child-type-not-allowed";

function validateRuntimeTransition(input: {
  transition: MeetingTaskRuntimeTransitionKind;
  beforeParent?: ActiveInterviewParent;
  afterParent?: ActiveInterviewParent;
  beforeScreen?: ActiveScreenTask;
  afterScreen?: ActiveScreenTask;
}): RuntimeTransitionRejectionReason | undefined {
  const { transition, beforeParent, afterParent } = input;
  if (transition === "create-parent") {
    if (beforeParent || !afterParent || afterParent.revisions < 1) {
      return "invalid-transition";
    }
    return isRuntimeParentTypeAllowed(afterParent)
      ? undefined
      : "parent-type-not-allowed";
  }
  if (transition === "replace-parent") {
    if (
      !beforeParent ||
      !afterParent ||
      (beforeParent.id === afterParent.id &&
        beforeParent.stableKind === afterParent.stableKind) ||
      afterParent.revisions < 1
    ) {
      return "invalid-transition";
    }
    return isRuntimeParentTypeAllowed(afterParent)
      ? undefined
      : "parent-type-not-allowed";
  }
  if (transition === "attach-child") {
    if (
      !beforeParent ||
      !afterParent ||
      beforeParent.id !== afterParent.id ||
      beforeParent.stableKind !== afterParent.stableKind ||
      !afterParent.child ||
      afterParent.revisions !== beforeParent.revisions + 1
    ) {
      return "invalid-transition";
    }
    const parentType = normalizeCanonicalQuestionType(afterParent.stableKind);
    const childType = normalizeCanonicalQuestionType(
      afterParent.child.questionType
    );
    return parentType &&
      childType &&
      canParentQuestionTypeOwnChild(parentType, childType)
      ? undefined
      : "child-type-not-allowed";
  }
  if (transition === "resume-parent") {
    return Boolean(
      beforeParent?.child &&
        afterParent &&
        beforeParent.id === afterParent.id &&
        !afterParent.child &&
        afterParent.revisions === beforeParent.revisions + 1
    )
      ? undefined
      : "invalid-transition";
  }
  if (transition === "set-phase") {
    const parentPhaseChanged = Boolean(
      beforeParent &&
        afterParent &&
        !beforeParent.child &&
        !afterParent.child &&
        beforeParent.playbookPhase !== afterParent.playbookPhase
    );
    const childPhaseChanged = Boolean(
      beforeParent?.child?.id &&
        beforeParent.child.id === afterParent?.child?.id &&
        beforeParent.child.phaseState &&
        afterParent?.child?.phaseState &&
        beforeParent.child.phaseState.phase !==
          afterParent.child.phaseState.phase &&
        afterParent.child.phaseState.revision ===
          beforeParent.child.phaseState.revision + 1
    );
    return Boolean(
      beforeParent &&
        afterParent &&
        beforeParent.id === afterParent.id &&
        (parentPhaseChanged || childPhaseChanged) &&
        afterParent.revisions === beforeParent.revisions + 1
    )
      ? undefined
      : "invalid-transition";
  }
  if (transition === "update-parent-context") {
    return Boolean(
      (!beforeParent && !afterParent) ||
        (beforeParent &&
          afterParent &&
          beforeParent.id === afterParent.id &&
          afterParent.revisions >= beforeParent.revisions)
    )
      ? undefined
      : "invalid-transition";
  }
  return Boolean(
    input.beforeScreen?.id !== input.afterScreen?.id ||
      input.beforeScreen?.updatedAt !== input.afterScreen?.updatedAt ||
      input.beforeScreen?.content !== input.afterScreen?.content ||
      input.beforeScreen?.expiresAt !== input.afterScreen?.expiresAt ||
      input.beforeParent?.id !== input.afterParent?.id ||
      input.beforeParent?.revisions !== input.afterParent?.revisions
  )
    ? undefined
    : "invalid-transition";
}

function isRuntimeParentTypeAllowed(parent: ActiveInterviewParent) {
  const parentType = normalizeCanonicalQuestionType(parent.stableKind);
  return Boolean(parentType && canQuestionTypeCreateParent(parentType));
}

function cloneRuntimeValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
