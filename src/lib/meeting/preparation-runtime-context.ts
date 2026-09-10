import type {
  PreparationRuntimeCapabilityUpdate,
  PreparationRuntimeContextLoader,
  PreparationRuntimePresentation,
  PreparationRuntimeContext,
  PinnedPreparationSnapshotIdentity,
  PreparationRuntimePersonalizedProjections,
  PreparationRuntimeLowImpactProjections,
  PreparationRuntimeProjection,
  PreparationRuntimeArtifactRef,
  PreparationRuntimeCapabilityState,
  PreparationRuntimeLoadState,
} from "./preparation-runtime-contracts.js";

import { PREPARATION_PERSONALIZED_GUIDANCE_VERSION } from "./preparation-runtime-contracts.js";
import { PREPARATION_RUNTIME_REINFORCEMENT_VERSION } from "./preparation-runtime-contracts.js";
import { PREPARATION_RUNTIME_CONTEXT_VERSION } from "./preparation-runtime-contracts.js";
import type {
  InterviewPreparationSnapshot,
  PreparationCurrentContext,
  PreparationSnapshotArtifactIdentity,
} from "../preparation/index.js";

export function createNeutralPreparationRuntimeContext(input: {
  meetingSessionId: string;
  preparationContextRevision: number;
  selectionRevision?: number;
  loadState?: Extract<PreparationRuntimeLoadState, "loading" | "neutral" | "failed">;
  loadFailure?: PreparationRuntimeContext["loadFailure"];
  createdAt?: number;
}): PreparationRuntimeContext {
  return deepFreeze({
    version: PREPARATION_RUNTIME_CONTEXT_VERSION,
    meetingSessionId: input.meetingSessionId,
    preparationContextRevision: input.preparationContextRevision,
    selectionRevision: input.selectionRevision ?? 0,
    mode: "neutral",
    loadState: input.loadState ?? "neutral",
    createdAt: input.createdAt ?? Date.now(),
    capabilities: buildCapabilities(false),
    loadFailure: input.loadFailure,
  });
}

export async function loadPreparationRuntimeContext(input: {
  meetingSessionId: string;
  preparationContextRevision: number;
  loader: PreparationRuntimeContextLoader;
  createdAt?: number;
  maxSelectionAttempts?: number;
}): Promise<PreparationRuntimeContext> {
  const maxAttempts = Math.max(1, input.maxSelectionAttempts ?? 3);
  let latestSelection: PreparationCurrentContext | undefined;

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const before = await input.loader.readSelection();
      latestSelection = before;
      if (!before.processId || !before.roundId || !before.selectedSnapshotId) {
        const after = await input.loader.readSelection();
        if (sameSelection(before, after)) {
          return createNeutralPreparationRuntimeContext({
            meetingSessionId: input.meetingSessionId,
            preparationContextRevision: input.preparationContextRevision,
            selectionRevision: after.revision,
            createdAt: input.createdAt,
          });
        }
        continue;
      }

      const snapshot = await input.loader.readSelectedSnapshot();
      const after = await input.loader.readSelection();
      latestSelection = after;
      if (!sameSelection(before, after)) continue;
      if (
        !snapshot ||
        snapshot.id !== after.selectedSnapshotId ||
        snapshot.processId !== after.processId ||
        snapshot.roundId !== after.roundId ||
        snapshot.status !== "active"
      ) {
        throw new PreparationRuntimePinError(
          "selected-snapshot-mismatch",
          "The selected preparation snapshot could not be pinned consistently."
        );
      }

      return buildPreparedRuntimeContext({
        meetingSessionId: input.meetingSessionId,
        preparationContextRevision: input.preparationContextRevision,
        selection: after,
        snapshot,
        createdAt: input.createdAt,
      });
    }

    throw new PreparationRuntimePinError(
      "selection-changed-during-pin",
      "The preparation selection changed while the meeting session was starting."
    );
  } catch (error) {
    const failure = normalizePinFailure(error);
    return createNeutralPreparationRuntimeContext({
      meetingSessionId: input.meetingSessionId,
      preparationContextRevision: input.preparationContextRevision,
      selectionRevision: latestSelection?.revision,
      loadState: "failed",
      loadFailure: failure,
      createdAt: input.createdAt,
    });
  }
}

export function toPreparationRuntimePresentation(
  context: PreparationRuntimeContext
): PreparationRuntimePresentation {
  const snapshot = context.pinnedSnapshot;
  return {
    version: context.version,
    meetingSessionId: context.meetingSessionId,
    preparationContextRevision: context.preparationContextRevision,
    selectionRevision: context.selectionRevision,
    mode: context.mode,
    loadState: context.loadState,
    snapshot: snapshot
      ? {
          snapshotId: snapshot.snapshotId,
          processId: snapshot.processId,
          roundId: snapshot.roundId,
          version: snapshot.version,
          contentHash: snapshot.contentHash,
          compilerVersion: snapshot.compilerVersion,
          playbookRegistryVersion: snapshot.playbookRegistryVersion,
          runtimeCapabilityVersion: snapshot.runtimeCapabilityVersion,
          selectionRevision: snapshot.selectionRevision,
          selectedAt: snapshot.selectedAt,
          activatedAt: snapshot.activatedAt,
          artifactCount: snapshot.artifactManifest.artifacts.length,
          company:
            context.projections?.lowImpact.runtimeBrief.value.company,
          role: context.projections?.lowImpact.runtimeBrief.value.role,
          roundTitle:
            context.projections?.lowImpact.runtimeBrief.value.roundTitle,
          stage:
            context.projections?.lowImpact.runtimeBrief.value.stage,
        }
      : undefined,
    capabilities: clone(context.capabilities),
    projectionCounts: {
      lowImpact: countLowImpactProjections(context.projections?.lowImpact),
      personalized: countPersonalizedProjections(
        context.projections?.personalized
      ),
    },
    loadFailure: context.loadFailure ? { ...context.loadFailure } : undefined,
  };
}

export function updatePreparationRuntimeCapabilities(
  context: PreparationRuntimeContext,
  update: PreparationRuntimeCapabilityUpdate
): PreparationRuntimeContext {
  if (update.preparationContextRevision <= context.preparationContextRevision) {
    throw new PreparationRuntimePinError(
      "non-monotonic-context-revision",
      "Preparation capability updates require a newer context revision."
    );
  }

  const available =
    context.mode === "prepared" &&
    context.loadState === "ready" &&
    Boolean(context.pinnedSnapshot && context.projections);
  const requestedRuntime =
    update.runtimeReinforcementEnabled ??
    context.capabilities.runtimeReinforcement.enabled;
  const runtimeEnabled = available && requestedRuntime;
  const requestedPersonalized =
    update.personalizedGuidanceEnabled ??
    context.capabilities.personalizedGuidance.enabled;
  const personalizedEnabled =
    available && runtimeEnabled && requestedPersonalized;

  return deepFreeze({
    ...clone(context),
    preparationContextRevision: update.preparationContextRevision,
    createdAt: update.createdAt ?? Date.now(),
    capabilities: buildCapabilities(available, {
      runtimeReinforcementEnabled: runtimeEnabled,
      personalizedGuidanceEnabled: personalizedEnabled,
    }),
    projections: context.projections
      ? rebaseProjections(
          context.projections,
          update.preparationContextRevision
        )
      : undefined,
  });
}

function buildPreparedRuntimeContext(input: {
  meetingSessionId: string;
  preparationContextRevision: number;
  selection: PreparationCurrentContext;
  snapshot: InterviewPreparationSnapshot;
  createdAt?: number;
}): PreparationRuntimeContext {
  const { snapshot } = input;
  const artifacts = snapshot.artifactManifest.artifacts;
  const project = <T>(
    target: string,
    value: T,
    artifactRefs: PreparationSnapshotArtifactIdentity[]
  ): PreparationRuntimeProjection<T> => {
    if (artifactRefs.length === 0) {
      throw new PreparationRuntimePinError(
        "projection-without-provenance",
        `Preparation projection ${target} has no artifact provenance.`
      );
    }
    return {
      projectionId: `${snapshot.id}:${target}`,
      snapshotId: snapshot.id,
      preparationContextRevision: input.preparationContextRevision,
      value: clone(value),
      artifactRefs: artifactRefs.map(cloneArtifact),
    };
  };
  const bySection = (section: PreparationSnapshotArtifactIdentity["section"]) =>
    artifacts.filter((artifact) => artifact.section === section);
  const byPathPrefix = (prefixes: string[]) =>
    artifacts.filter((artifact) =>
      prefixes.some(
        (prefix) =>
          artifact.artifactPath === prefix ||
          artifact.artifactPath.startsWith(`${prefix}/`)
      )
    );

  const programmingLanguage = snapshot.runtimeBrief.preferredProgrammingLanguage;
  const lowImpact: PreparationRuntimeLowImpactProjections = {
    runtimeBrief: project(
      "runtime-brief",
      snapshot.runtimeBrief,
      bySection("runtime-brief")
    ),
    questionTypePrior: project(
      "question-type-prior",
      {
        expectedInterviewTypes: snapshot.runtimeBrief.expectedInterviewTypes,
        expectedTypePolicy: snapshot.runtimeBrief.expectedTypePolicy,
      },
      byPathPrefix([
        "runtime-brief/expectedInterviewTypes",
        "runtime-brief/expectedTypePolicy",
      ])
    ),
    programmingLanguage: programmingLanguage
      ? project(
          "programming-language",
          programmingLanguage,
          byPathPrefix(["runtime-brief/preferredProgrammingLanguage"])
        )
      : undefined,
    speechBiasTerms: snapshot.speechBiasTerms.map((term) =>
      project(
        `speech-bias:${term.statementId}`,
        term,
        byPathPrefix([`speech-bias/${encodeURIComponent(term.statementId)}`])
      )
    ),
  };

  const personalized: PreparationRuntimePersonalizedProjections = {
    strategy: project("strategy", snapshot.strategy, bySection("strategy")),
    factEvidence: snapshot.evidencePack.items.map((item) =>
      project(
        `fact-evidence:${item.statementId}`,
        item,
        byPathPrefix([`evidence/${encodeURIComponent(item.statementId)}`])
      )
    ),
    kmbEvidenceHints: snapshot.evidenceIndex
      .filter((item) => item.sourceType === "curated-kmb")
      .map((item) =>
        project(
          `kmb-evidence:${item.sourceId}`,
          {
            entryId: item.sourceId,
            title: item.title,
            contentHash: item.contentHash,
          },
          byPathPrefix([
            `evidence-index/curated-kmb/${encodeURIComponent(item.sourceId)}`,
          ])
        )
      ),
    openingItems: snapshot.openingPack.items.map((item) =>
      project(
        `opening:${item.graphId}:${item.nodeId}`,
        item,
        byPathPrefix([
          `opening/${encodeURIComponent(item.graphId)}/${encodeURIComponent(item.nodeId)}`,
        ])
      )
    ),
    narrativeGraphs: snapshot.narrativePack.graphs.map((graph) =>
      project(
        `narrative:${graph.graphId}`,
        graph,
        byPathPrefix([`narratives/${encodeURIComponent(graph.graphId)}`])
      )
    ),
    playbookOverlays: snapshot.playbookOverlays.map((overlay) =>
      project(
        `playbook:${overlay.expectedInterviewType}`,
        overlay,
        byPathPrefix([
          `playbooks/${encodeURIComponent(overlay.expectedInterviewType)}`,
        ])
      )
    ),
  };

  const pinnedSnapshot: PinnedPreparationSnapshotIdentity = {
    snapshotId: snapshot.id,
    processId: snapshot.processId,
    roundId: snapshot.roundId,
    version: snapshot.version,
    contentHash: snapshot.contentHash,
    compilerVersion: snapshot.compilerVersion,
    playbookRegistryVersion: snapshot.playbookRegistryVersion,
    runtimeCapabilityVersion: snapshot.runtimeCapabilityVersion,
    selectionRevision: input.selection.revision,
    selectedAt: input.selection.updatedAt,
    activatedAt: snapshot.activatedAt,
    artifactManifest: clone(snapshot.artifactManifest),
  };

  return deepFreeze({
    version: PREPARATION_RUNTIME_CONTEXT_VERSION,
    meetingSessionId: input.meetingSessionId,
    preparationContextRevision: input.preparationContextRevision,
    selectionRevision: input.selection.revision,
    mode: "prepared",
    loadState: "ready",
    createdAt: input.createdAt ?? Date.now(),
    pinnedSnapshot,
    capabilities: buildCapabilities(true, {
      runtimeReinforcementEnabled: true,
      personalizedGuidanceEnabled: true,
    }),
    projections: { lowImpact, personalized },
  });
}

function buildCapabilities(
  available: boolean,
  enabled: {
    runtimeReinforcementEnabled?: boolean;
    personalizedGuidanceEnabled?: boolean;
  } = {}
): PreparationRuntimeCapabilityState {
  const runtimeEnabled =
    available && Boolean(enabled.runtimeReinforcementEnabled);
  return {
    runtimeReinforcement: {
      version: PREPARATION_RUNTIME_REINFORCEMENT_VERSION,
      available,
      enabled: runtimeEnabled,
    },
    personalizedGuidance: {
      version: PREPARATION_PERSONALIZED_GUIDANCE_VERSION,
      available,
      enabled:
        runtimeEnabled &&
        Boolean(enabled.personalizedGuidanceEnabled),
      requiresRuntimeReinforcement: true,
    },
  };
}

function rebaseProjections(
  projections: NonNullable<PreparationRuntimeContext["projections"]>,
  preparationContextRevision: number
): NonNullable<PreparationRuntimeContext["projections"]> {
  const rebase = <T>(projection: PreparationRuntimeProjection<T>) => ({
    ...clone(projection),
    preparationContextRevision,
  });
  return {
    lowImpact: {
      runtimeBrief: rebase(projections.lowImpact.runtimeBrief),
      questionTypePrior: rebase(projections.lowImpact.questionTypePrior),
      programmingLanguage: projections.lowImpact.programmingLanguage
        ? rebase(projections.lowImpact.programmingLanguage)
        : undefined,
      speechBiasTerms: projections.lowImpact.speechBiasTerms.map(rebase),
    },
    personalized: {
      strategy: rebase(projections.personalized.strategy),
      factEvidence: projections.personalized.factEvidence.map(rebase),
      kmbEvidenceHints:
        projections.personalized.kmbEvidenceHints.map(rebase),
      openingItems: projections.personalized.openingItems.map(rebase),
      narrativeGraphs:
        projections.personalized.narrativeGraphs.map(rebase),
      playbookOverlays:
        projections.personalized.playbookOverlays.map(rebase),
    },
  };
}

function sameSelection(
  left: PreparationCurrentContext,
  right: PreparationCurrentContext
) {
  return (
    left.revision === right.revision &&
    left.processId === right.processId &&
    left.roundId === right.roundId &&
    left.selectedSnapshotId === right.selectedSnapshotId
  );
}

function cloneArtifact(
  artifact: PreparationSnapshotArtifactIdentity
): PreparationRuntimeArtifactRef {
  return {
    ...artifact,
    sourceRefs: artifact.sourceRefs.map((source) => ({ ...source })),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

function countLowImpactProjections(
  projections: PreparationRuntimeLowImpactProjections | undefined
) {
  if (!projections) return 0;
  return (
    2 +
    (projections.programmingLanguage ? 1 : 0) +
    projections.speechBiasTerms.length
  );
}

function countPersonalizedProjections(
  projections: PreparationRuntimePersonalizedProjections | undefined
) {
  if (!projections) return 0;
  return (
    1 +
    projections.factEvidence.length +
    projections.kmbEvidenceHints.length +
    projections.openingItems.length +
    projections.narrativeGraphs.length +
    projections.playbookOverlays.length
  );
}

class PreparationRuntimePinError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PreparationRuntimePinError";
  }
}

function normalizePinFailure(error: unknown) {
  if (error instanceof PreparationRuntimePinError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "preparation-runtime-load-failed",
    message:
      error instanceof Error
        ? error.message
        : "The preparation runtime context could not be loaded.",
  };
}
