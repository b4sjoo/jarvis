import type { MemoryEntry } from "../memory/types.js";
import type { PreparationMaterialExtractionRepository } from "./extraction-types.js";
import type {
  InterviewProcess,
  InterviewProcessRepository,
  InterviewRound,
  PreparationExpectedInterviewType,
} from "./interview-types.js";
import { createPreparationProfileSourceFingerprint } from "./preparation-composition-service.js";
import { buildPreparationSnapshotArtifactManifest } from "./snapshot-artifact-manifest.js";
import {
  PREPARATION_PLAYBOOK_REGISTRY_VERSION,
  PREPARATION_RUNTIME_CAPABILITY_VERSION,
  PREPARATION_SNAPSHOT_COMPILER_VERSION,
  PREPARATION_SNAPSHOT_RUNTIME_BUDGET_CHARS,
  type InterviewPreparationSnapshot,
  type PreparationEvidenceItem,
  type PreparationNarrativePack,
  type PreparationOpeningPack,
  type PreparationPlaybookOverlay,
  type PreparationSnapshotDiffSection,
  type PreparationSnapshotEvidenceIndexEntry,
  type PreparationSnapshotRepository,
  type PreparationSnapshotSourceManifest,
  type PreparationSnapshotWarning,
  type PreparationSpeechBiasTerm,
} from "./snapshot-types.js";
import type {
  InterviewPreparationProfileRevision,
  PreparationCompositionRepository,
  PreparationNarrativeGraph,
  PreparationStatementRepository,
  PreparationStatementWithSources,
} from "./statement-types.js";
import { stablePreparationHash } from "./statement-proposal-service.js";

const MAX_CONFIRMED_STATEMENTS = 80;
const MAX_EVIDENCE_ITEMS = 32;
const MAX_NARRATIVE_NODES = 40;
const MAX_EVIDENCE_INDEX_ITEMS = 120;
const MAX_SPEECH_BIAS_TERMS = 32;

export class PreparationCurrentContextSwitchRequiredError extends Error {
  readonly code = "preparation-current-context-switch-required";

  constructor(
    readonly current: { processId?: string; roundId?: string; snapshotId?: string },
    readonly target: { processId: string; roundId: string; snapshotId?: string }
  ) {
    super(
      "Another interview Round is current. Confirm the context switch before continuing."
    );
    this.name = "PreparationCurrentContextSwitchRequiredError";
  }
}

export interface PreparationSnapshotEvent {
  name:
    | "Preparation snapshot compilation started"
    | "Preparation snapshot compilation reused"
    | "Preparation snapshot compilation finished"
    | "Preparation snapshot compilation failed"
    | "Preparation snapshot activated"
    | "Preparation snapshot deactivated"
    | "Preparation current context changed";
  timestamp: number;
  processId: string;
  roundId: string;
  snapshotId?: string;
  snapshotVersion?: number;
  profileRevision?: number;
  contentHash?: string;
  runtimeCharCount?: number;
  warningCount?: number;
  selectionRevision?: number;
  durationMs?: number;
  error?: string;
}

export function createPreparationSnapshotService(dependencies: {
  statements: PreparationStatementRepository;
  composition: PreparationCompositionRepository;
  snapshots: PreparationSnapshotRepository;
  interviewProcesses: InterviewProcessRepository;
  materialExtraction: PreparationMaterialExtractionRepository;
  getKmbEntries: () => Promise<MemoryEntry[]>;
  now?: () => number;
  createId?: () => string;
  onEvent?: (event: PreparationSnapshotEvent) => void;
}) {
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? (() => crypto.randomUUID());
  const emit = (event: PreparationSnapshotEvent) => dependencies.onEvent?.(event);
  const compilationTails = new Map<string, Promise<unknown>>();

  const enqueueCompilation = <T>(key: string, task: () => Promise<T>) => {
    const previous = compilationTails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    compilationTails.set(key, current);
    return current.finally(() => {
      if (compilationTails.get(key) === current) {
        compilationTails.delete(key);
      }
    });
  };

  return {
    list(input: { processId: string; roundId: string }) {
      return dependencies.snapshots.list(input);
    },

    getActive(input: { processId: string; roundId: string }) {
      return dependencies.snapshots.getActive(input);
    },

    getCurrentContext() {
      return dependencies.snapshots.getCurrentContext();
    },

    async getCurrentSnapshot() {
      const context = await dependencies.snapshots.getCurrentContext();
      if (!context.processId || !context.selectedSnapshotId) return undefined;
      return dependencies.snapshots.get(
        context.processId,
        context.selectedSnapshotId
      );
    },

    listCurrentContextEvents() {
      return dependencies.snapshots.listCurrentContextEvents();
    },

    listActivationEvents(input: { processId: string; roundId: string }) {
      return dependencies.snapshots.listActivationEvents(input);
    },

    compile(input: {
      processId: string;
      roundId: string;
      profileRevisionId: string;
    }) {
      return enqueueCompilation(
        `${input.processId}\u0000${input.roundId}`,
        async () => {
          const startedAt = now();
          emit({
            name: "Preparation snapshot compilation started",
            timestamp: startedAt,
            processId: input.processId,
            roundId: input.roundId,
          });
          try {
            const prepared = await prepareSnapshotCompilation(dependencies, input);
            const existing = await dependencies.snapshots.getByContentHash({
              processId: input.processId,
              roundId: input.roundId,
              contentHash: prepared.contentHash,
            });
            if (existing) {
              emit({
                name: "Preparation snapshot compilation reused",
                timestamp: now(),
                processId: input.processId,
                roundId: input.roundId,
                snapshotId: existing.id,
                snapshotVersion: existing.version,
                profileRevision: existing.profileRevision,
                contentHash: existing.contentHash,
                runtimeCharCount: existing.runtimeCharCount,
                warningCount: existing.warnings.length,
                durationMs: now() - startedAt,
              });
              return { snapshot: existing, created: false };
            }
            const version = await dependencies.snapshots.nextVersion(input);
            const snapshotId = `preparation-snapshot-${createId()}`;
            const artifactManifest = buildPreparationSnapshotArtifactManifest({
              snapshotId,
              payload: {
                ...prepared.artifacts,
                sourceManifest: prepared.sourceManifest,
                warnings: prepared.warnings,
              },
              statementIdsByContent: statementIdsByNormalizedContent(
                prepared.confirmedStatements
              ),
            });
            const snapshot: InterviewPreparationSnapshot = {
              id: snapshotId,
              processId: input.processId,
              roundId: input.roundId,
              version,
              profileRevisionId: prepared.profile.id,
              profileRevision: prepared.profile.revision,
              compilerVersion: PREPARATION_SNAPSHOT_COMPILER_VERSION,
              playbookRegistryVersion: PREPARATION_PLAYBOOK_REGISTRY_VERSION,
              runtimeCapabilityVersion: PREPARATION_RUNTIME_CAPABILITY_VERSION,
              sourceFingerprint: prepared.sourceFingerprint,
              contentHash: prepared.contentHash,
              runtimeCharCount: prepared.runtimeCharCount,
              ...prepared.artifacts,
              artifactManifest,
              sourceManifest: prepared.sourceManifest,
              warnings: prepared.warnings,
              status: "ready",
              createdAt: now(),
            };
            await dependencies.snapshots.insert({
              snapshot,
              statementRevisions: prepared.confirmedStatements.map((statement) => ({
                statementId: statement.id,
                statementRevision: statement.revision,
              })),
              narrativeNodeRevisions: prepared.narrativePack.graphs.flatMap((graph) =>
                graph.nodes.map((node, ordinal) => ({
                  nodeId: node.nodeId,
                  nodeRevision:
                    prepared.narrativeNodeRevisions.get(node.nodeId) ?? 0,
                  ordinal,
                }))
              ),
              materialRevisions: prepared.sourceManifest.materials.map(
                (material, ordinal) => ({ ...material, ordinal })
              ),
              kmbEntries: prepared.sourceManifest.kmbEntries.map(
                (entry, ordinal) => ({
                  ...entry,
                  ordinal,
                })
              ),
            });
            emit({
              name: "Preparation snapshot compilation finished",
              timestamp: now(),
              processId: input.processId,
              roundId: input.roundId,
              snapshotId: snapshot.id,
              snapshotVersion: snapshot.version,
              profileRevision: snapshot.profileRevision,
              contentHash: snapshot.contentHash,
              runtimeCharCount: snapshot.runtimeCharCount,
              warningCount: snapshot.warnings.length,
              durationMs: now() - startedAt,
            });
            return { snapshot, created: true };
          } catch (error) {
            emit({
              name: "Preparation snapshot compilation failed",
              timestamp: now(),
              processId: input.processId,
              roundId: input.roundId,
              durationMs: now() - startedAt,
              error: errorMessage(error),
            });
            throw error;
          }
        }
      );
    },

    async setCurrentContext(input: {
      processId: string;
      roundId: string;
      allowContextSwitch?: boolean;
    }) {
      const [context, process, round] = await Promise.all([
        dependencies.snapshots.getCurrentContext(),
        dependencies.interviewProcesses.getProcess(input.processId),
        dependencies.interviewProcesses.getRound(input.roundId),
      ]);
      requireWritableRound(process, round, input);
      const switchesContext = Boolean(
        context.processId &&
          (context.processId !== input.processId || context.roundId !== input.roundId)
      );
      if (switchesContext && !input.allowContextSwitch) {
        throw new PreparationCurrentContextSwitchRequiredError(
          {
            processId: context.processId,
            roundId: context.roundId,
            snapshotId: context.selectedSnapshotId,
          },
          input
        );
      }
      const updatedAt = now();
      const settled = await dependencies.snapshots.setCurrentContext({
        processId: input.processId,
        roundId: input.roundId,
        expectedRevision: context.revision,
        updatedAt,
      });
      if (!settled) {
        throw new Error("The current interview context changed. Review it and try again.");
      }
      const updated = await dependencies.snapshots.getCurrentContext();
      emit({
        name: "Preparation current context changed",
        timestamp: updatedAt,
        processId: input.processId,
        roundId: input.roundId,
        snapshotId: updated.selectedSnapshotId,
        selectionRevision: updated.revision,
      });
      return updated;
    },

    async activate(input: {
      processId: string;
      roundId: string;
      snapshotId: string;
      allowContextSwitch?: boolean;
    }) {
      const [snapshot, context] = await Promise.all([
        dependencies.snapshots.get(input.processId, input.snapshotId),
        dependencies.snapshots.getCurrentContext(),
      ]);
      if (!snapshot || snapshot.roundId !== input.roundId) {
        throw new Error("Preparation snapshot not found for this round.");
      }
      const switchesContext = Boolean(
        context.processId &&
          (context.processId !== input.processId || context.roundId !== input.roundId)
      );
      if (switchesContext && !input.allowContextSwitch) {
        throw new PreparationCurrentContextSwitchRequiredError(
          {
            processId: context.processId,
            roundId: context.roundId,
            snapshotId: context.selectedSnapshotId,
          },
          input
        );
      }
      await validateSnapshotActivationAuthority(dependencies, snapshot);
      const activatedAt = now();
      const activated = await dependencies.snapshots.activate({
        processId: input.processId,
        roundId: input.roundId,
        snapshotId: input.snapshotId,
        expectedContentHash: snapshot.contentHash,
        expectedContextRevision: context.revision,
        activatedAt,
      });
      if (!activated) {
        throw new Error(
          "Snapshot activation was rejected because its authority changed."
        );
      }
      const active = await dependencies.snapshots.getActive({
        processId: input.processId,
        roundId: input.roundId,
      });
      if (!active || active.id !== input.snapshotId) {
        throw new Error("Snapshot activation did not settle on the selected version.");
      }
      const settledContext = await dependencies.snapshots.getCurrentContext();
      if (
        settledContext.processId !== input.processId ||
        settledContext.roundId !== input.roundId ||
        settledContext.selectedSnapshotId !== input.snapshotId
      ) {
        throw new Error("Snapshot activation did not settle the global current context.");
      }
      emit({
        name: "Preparation snapshot activated",
        timestamp: activatedAt,
        processId: input.processId,
        roundId: input.roundId,
        snapshotId: active.id,
        snapshotVersion: active.version,
        profileRevision: active.profileRevision,
        contentHash: active.contentHash,
        runtimeCharCount: active.runtimeCharCount,
        warningCount: active.warnings.length,
      });
      return active;
    },

    async deactivate(input: {
      processId: string;
      roundId: string;
      snapshotId: string;
    }) {
      const [snapshot, active, process, round] = await Promise.all([
        dependencies.snapshots.get(input.processId, input.snapshotId),
        dependencies.snapshots.getActive({
          processId: input.processId,
          roundId: input.roundId,
        }),
        dependencies.interviewProcesses.getProcess(input.processId),
        dependencies.interviewProcesses.getRound(input.roundId),
      ]);
      requireWritableRound(process, round, input);
      if (
        !snapshot ||
        snapshot.roundId !== input.roundId ||
        active?.id !== snapshot.id
      ) {
        throw new Error("The selected snapshot is no longer active for this round.");
      }
      const deactivatedAt = now();
      const context = await dependencies.snapshots.getCurrentContext();
      const deactivated = await dependencies.snapshots.deactivate({
        processId: input.processId,
        roundId: input.roundId,
        snapshotId: input.snapshotId,
        expectedContextRevision: context.revision,
        deactivatedAt,
      });
      if (!deactivated) {
        throw new Error("Snapshot deactivation did not settle.");
      }
      const remainingActive = await dependencies.snapshots.getActive({
        processId: input.processId,
        roundId: input.roundId,
      });
      if (remainingActive) {
        throw new Error("Snapshot deactivation left an active selection behind.");
      }
      const updated = await dependencies.snapshots.get(
        input.processId,
        input.snapshotId
      );
      if (!updated) {
        throw new Error("Deactivated snapshot could not be reloaded.");
      }
      emit({
        name: "Preparation snapshot deactivated",
        timestamp: deactivatedAt,
        processId: input.processId,
        roundId: input.roundId,
        snapshotId: updated.id,
        snapshotVersion: updated.version,
        profileRevision: updated.profileRevision,
        contentHash: updated.contentHash,
        runtimeCharCount: updated.runtimeCharCount,
        warningCount: updated.warnings.length,
      });
      return updated;
    },
  };
}

async function validateSnapshotActivationAuthority(
  dependencies: {
    statements: PreparationStatementRepository;
    composition: PreparationCompositionRepository;
    interviewProcesses: InterviewProcessRepository;
    materialExtraction: PreparationMaterialExtractionRepository;
    getKmbEntries: () => Promise<MemoryEntry[]>;
  },
  snapshot: InterviewPreparationSnapshot
) {
  const [process, round, statements, narratives, kmbEntries] = await Promise.all([
    dependencies.interviewProcesses.getProcess(snapshot.processId),
    dependencies.interviewProcesses.getRound(snapshot.roundId),
    dependencies.statements.list({
      processId: snapshot.processId,
      roundId: snapshot.roundId,
    }),
    dependencies.composition.listNarrativeGraphs({
      processId: snapshot.processId,
      roundId: snapshot.roundId,
    }),
    dependencies.getKmbEntries(),
  ]);
  requireWritableRound(process, round, snapshot);

  const statementsById = new Map(statements.map((statement) => [statement.id, statement]));
  const pinnedStatements = snapshot.sourceManifest.statements.map((pin) => {
    const statement = statementsById.get(pin.id);
    if (
      !statement ||
      statement.status !== "confirmed" ||
      statement.revision !== pin.revision ||
      statementContentHash(statement) !== pin.contentHash
    ) {
      throw new Error(
        "A pinned preparation statement changed or lost confirmed authority."
      );
    }
    return statement;
  });
  validateConfirmedAuthority(pinnedStatements);

  const narrativeNodes = new Map(
    narratives.flatMap((graph) =>
      graph.nodes.map((node) => [
        `${graph.id}\u0000${node.id}`,
        { graph, node },
      ] as const)
    )
  );
  for (const pin of snapshot.sourceManifest.narrativeNodes) {
    const current = narrativeNodes.get(`${pin.graphId}\u0000${pin.nodeId}`);
    if (
      !current ||
      current.graph.status !== "current" ||
      current.graph.revision !== pin.graphRevision ||
      current.graph.profileRevisionId !== snapshot.profileRevisionId ||
      current.node.reviewStatus !== "confirmed" ||
      current.node.revision !== pin.nodeRevision
    ) {
      throw new Error(
        "A pinned preparation narrative changed or lost confirmed authority."
      );
    }
  }

  for (const pin of snapshot.sourceManifest.materials) {
    const candidate = await dependencies.materialExtraction.getCurrent(
      pin.materialId
    );
    if (
      !candidate ||
      candidate.revisionId !== pin.materialRevisionId ||
      candidate.sourceChecksumSha256 !== pin.sourceChecksumSha256 ||
      !isMaterialRevisionEligibleForSnapshot(candidate)
    ) {
      throw new Error(
        "A pinned preparation material changed or lost review authority."
      );
    }
  }

  const kmbById = new Map(kmbEntries.map((entry) => [entry.id, entry]));
  for (const pin of snapshot.sourceManifest.kmbEntries) {
    const entry = kmbById.get(pin.entryId);
    if (
      !entry ||
      !entry.enabled ||
      stablePreparationHash(entry.content) !== pin.contentHash
    ) {
      throw new Error("A pinned curated memory entry changed or was disabled.");
    }
  }
}

async function prepareSnapshotCompilation(
  dependencies: {
    statements: PreparationStatementRepository;
    composition: PreparationCompositionRepository;
    interviewProcesses: InterviewProcessRepository;
    materialExtraction: PreparationMaterialExtractionRepository;
    getKmbEntries: () => Promise<MemoryEntry[]>;
  },
  input: { processId: string; roundId: string; profileRevisionId: string }
) {
  const [process, round, profile, statements, narratives, kmbEntries] =
    await Promise.all([
      dependencies.interviewProcesses.getProcess(input.processId),
      dependencies.interviewProcesses.getRound(input.roundId),
      dependencies.composition.getLatestProfile({
        processId: input.processId,
        scope: { kind: "round", roundId: input.roundId },
      }),
      dependencies.statements.list({
        processId: input.processId,
        roundId: input.roundId,
      }),
      dependencies.composition.listNarrativeGraphs({
        processId: input.processId,
        roundId: input.roundId,
      }),
      dependencies.getKmbEntries(),
    ]);
  requireWritableRound(process, round, input);
  if (!profile || profile.id !== input.profileRevisionId) {
    throw new Error("Compose or select the current round profile first.");
  }
  const confirmedStatements = statements
    .filter((statement) => statement.status === "confirmed")
    .sort(statementOrder);
  const unresolvedStatements = statements
    .filter((statement) => statement.status === "unresolved")
    .sort(statementOrder);
  if (!confirmedStatements.length) {
    throw new Error("Confirm preparation statements before compiling a snapshot.");
  }
  if (confirmedStatements.length > MAX_CONFIRMED_STATEMENTS) {
    throw new Error("The confirmed preparation profile exceeds the snapshot item budget.");
  }
  if (
    profile.sourceFingerprint !==
      createPreparationProfileSourceFingerprint(confirmedStatements) ||
    !sameStringSet(
      profile.confirmedStatementIds,
      confirmedStatements.map((statement) => statement.id)
    )
  ) {
    throw new Error("The preparation profile is stale. Recompose it first.");
  }

  validateConfirmedAuthority(confirmedStatements);
  const selectedNarratives = narratives
    .filter(
      (graph) =>
        graph.scope.kind === "round" &&
        graph.scope.roundId === input.roundId &&
        graph.profileRevisionId === profile.id &&
        graph.status === "current"
    )
    .sort(narrativeOrder);
  const { narrativePack, openingPack, narrativeNodeRevisions } =
    compileNarrativePacks(selectedNarratives);
  if (
    narrativePack.graphs.reduce((sum, graph) => sum + graph.nodes.length, 0) >
    MAX_NARRATIVE_NODES
  ) {
    throw new Error("Confirmed narrative nodes exceed the snapshot runtime budget.");
  }

  const sourceState = await compileSourceState({
    statements: confirmedStatements,
    materialExtraction: dependencies.materialExtraction,
    kmbEntries,
  });
  const warnings: PreparationSnapshotWarning[] = [];
  const evidencePack = {
    items: compileEvidencePack(confirmedStatements),
  };
  if (!evidencePack.items.length) {
    warnings.push({
      code: "no-personal-evidence",
      message: "This snapshot has no confirmed candidate or project evidence.",
      severity: "warning",
    });
  }
  const speechBiasTerms = compileSpeechBiasTerms(confirmedStatements, warnings);
  if (!openingPack.items.length) {
    warnings.push({
      code: "no-opening-pack",
      message: "No confirmed introduction narrative is available.",
      severity: "warning",
    });
  }
  if (!narrativePack.graphs.length) {
    warnings.push({
      code: "no-confirmed-narrative",
      message: "No confirmed Narrative Graph nodes are available for this round.",
      severity: "warning",
    });
  }
  const unresolvedHighImpactAssumptions = unresolvedStatements
    .filter((statement) =>
      [
        "candidate-fact",
        "project-evidence",
        "interview-logistics",
        "interview-policy",
        "risk",
      ].includes(statement.domain)
    )
    .map((statement) => statement.content);
  if (unresolvedHighImpactAssumptions.length) {
    warnings.push({
      code: "unresolved-high-impact-assumptions",
      message: `${unresolvedHighImpactAssumptions.length} high-impact preparation statement(s) remain unresolved.`,
      severity: "warning",
    });
  }

  const playbookOverlays = compilePlaybookOverlays(
    round!,
    profile,
    evidencePack.items
  );
  if (
    round!.expectedInterviewTypes.includes("personal-logistics") &&
    !playbookOverlays.some(
      (overlay) => overlay.expectedInterviewType === "personal-logistics"
    )
  ) {
    warnings.push({
      code: "no-personal-logistics-playbook",
      message:
        "Personal logistics remains a runtime question type without a dedicated playbook overlay.",
      severity: "warning",
    });
  }

  const artifacts = {
    runtimeBrief: {
      company: process!.company,
      role: process!.role,
      roundId: round!.id,
      roundTitle: round!.title,
      stage: round!.stage,
      expectedInterviewTypes: [...round!.expectedInterviewTypes].sort(),
      expectedTypePolicy: round!.expectedTypePolicy,
      preferredProgrammingLanguage: round!.preferredProgrammingLanguage,
      scheduledAt: round!.scheduledAt,
      interviewerName: round!.interviewerName,
      interviewerRole: round!.interviewerRole,
      focusAreas: uniqueStrings([
        ...profile.content.companyGuidance,
        ...profile.content.strategy,
      ]),
      compactNotes: uniqueStrings([
        ...profile.content.interviewPolicy,
        ...profile.content.logistics,
      ]),
      unresolvedHighImpactAssumptions,
    },
    strategy: {
      priorities: [...profile.content.strategy],
      risks: [...profile.content.risks],
      questionsToAsk: [...profile.content.questions],
      likelyBranches: [...profile.content.companyGuidance],
      timeAllocation: [],
    },
    evidencePack,
    speechBiasTerms,
    openingPack,
    narrativePack,
    sessionLaunchPlan: {
      recommendedRuntimeConfiguration: {
        expectedInterviewTypes: [...round!.expectedInterviewTypes].sort(),
        expectedTypePolicy: round!.expectedTypePolicy,
        preferredProgrammingLanguage: round!.preferredProgrammingLanguage,
      },
      smokeTests: [
        "Confirm the selected speech-to-text provider.",
        "Confirm the selected Meeting and Coding providers.",
        "Verify Focus Mode pause and resume before the call.",
      ],
      interviewFlow: [
        "Use the explicit live question as the primary task evidence.",
        "Use prepared evidence only when its interview-family boundary matches.",
      ],
      emergencyActions: [
        "Use correction for a misheard term.",
        "Use type correction when the current question family is wrong.",
        "Use Force Advise only as an explicit recovery action.",
      ],
      warnings: warnings.map((warning) => warning.message),
      promptExcluded: true as const,
    },
    playbookOverlays,
    evidenceIndex: sourceState.evidenceIndex,
  };
  const runtimePayload = {
    runtimeBrief: artifacts.runtimeBrief,
    strategy: artifacts.strategy,
    evidencePack: artifacts.evidencePack,
    speechBiasTerms: artifacts.speechBiasTerms,
    openingPack: artifacts.openingPack,
    narrativePack: artifacts.narrativePack,
    playbookOverlays: artifacts.playbookOverlays,
  };
  const runtimeCharCount = stableJson(runtimePayload).length;
  if (runtimeCharCount > PREPARATION_SNAPSHOT_RUNTIME_BUDGET_CHARS) {
    throw new Error(
      `Compiled runtime context exceeds the ${PREPARATION_SNAPSHOT_RUNTIME_BUDGET_CHARS}-character budget.`
    );
  }

  const sourceManifest: PreparationSnapshotSourceManifest = {
    process: {
      id: process!.id,
      contentHash: stablePreparationHash(
        stableJson({
          title: process!.title,
          company: process!.company,
          role: process!.role,
        })
      ),
    },
    round: {
      id: round!.id,
      contentHash: stablePreparationHash(
        stableJson({
          title: round!.title,
          stage: round!.stage,
          customStageLabel: round!.customStageLabel,
          expectedInterviewTypes: [...round!.expectedInterviewTypes].sort(),
          expectedTypePolicy: round!.expectedTypePolicy,
          scheduledAt: round!.scheduledAt,
          interviewerName: round!.interviewerName,
          interviewerRole: round!.interviewerRole,
          preferredProgrammingLanguage: round!.preferredProgrammingLanguage,
        })
      ),
    },
    profile: {
      id: profile.id,
      revision: profile.revision,
      contentHash: profile.contentHash,
      sourceFingerprint: profile.sourceFingerprint,
    },
    statements: confirmedStatements.map((statement) => ({
      id: statement.id,
      revision: statement.revision,
      contentHash: statementContentHash(statement),
    })),
    narrativeNodes: narrativePack.graphs.flatMap((graph) =>
      graph.nodes.map((node) => ({
        graphId: graph.graphId,
        graphRevision: graph.graphRevision,
        nodeId: node.nodeId,
        nodeRevision: narrativeNodeRevisions.get(node.nodeId) ?? 0,
      }))
    ),
    materials: sourceState.materials,
    kmbEntries: sourceState.kmbEntries,
    compilerVersion: PREPARATION_SNAPSHOT_COMPILER_VERSION,
    playbookRegistryVersion: PREPARATION_PLAYBOOK_REGISTRY_VERSION,
    runtimeCapabilityVersion: PREPARATION_RUNTIME_CAPABILITY_VERSION,
  };
  const sourceFingerprint = stablePreparationHash(stableJson(sourceManifest));
  const contentHash = stablePreparationHash(
    stableJson({
      artifacts,
      sourceManifest,
      warnings,
    })
  );
  return {
    profile,
    confirmedStatements,
    narrativePack,
    narrativeNodeRevisions,
    artifacts,
    sourceManifest,
    sourceFingerprint,
    contentHash,
    runtimeCharCount,
    warnings,
  };
}

function requireWritableRound(
  process: InterviewProcess | undefined,
  round: InterviewRound | undefined,
  input: { processId: string; roundId: string }
) {
  if (!process) throw new Error("Interview process not found.");
  if (process.status !== "active") {
    throw new Error("Archived interview processes are read-only.");
  }
  if (!round || round.processId !== input.processId || round.archivedAt) {
    throw new Error("Interview round does not belong to this process.");
  }
}

function validateConfirmedAuthority(statements: PreparationStatementWithSources[]) {
  for (const statement of statements) {
    if (
      ["candidate-fact", "project-evidence"].includes(statement.domain) &&
      (statement.authority !== "user-confirmed" ||
        statement.ownership === "unresolved" ||
        !statement.sources.some((source) => source.sourceType === "user-confirmation"))
    ) {
      throw new Error(
        "Candidate and project evidence must have resolved ownership and user confirmation."
      );
    }
    if (!statement.sources.length) {
      throw new Error("A confirmed statement has no source lineage.");
    }
  }
}

function statementContentHash(statement: PreparationStatementWithSources) {
  return stablePreparationHash(
    stableJson({
      content: statement.content,
      domain: statement.domain,
      ownership: statement.ownership,
      allowedWording: statement.allowedWording,
      prohibitedWording: statement.prohibitedWording,
      allowedInterviewFamilies: statement.allowedInterviewFamilies,
    })
  );
}

async function compileSourceState(input: {
  statements: PreparationStatementWithSources[];
  materialExtraction: PreparationMaterialExtractionRepository;
  kmbEntries: MemoryEntry[];
}) {
  const materialRefs = dedupeBy(
    input.statements.flatMap((statement) =>
      statement.sources
        .filter(
          (source) =>
            source.sourceType === "material-chunk" &&
            source.materialId &&
            source.materialRevisionId
        )
        .map((source) => ({
          materialId: source.materialId!,
          materialRevisionId: source.materialRevisionId!,
        }))
    ),
    (item) => `${item.materialId}\u0000${item.materialRevisionId}`
  );
  const materialCandidates = await Promise.all(
    materialRefs.map(async (reference) => {
      const candidate = await input.materialExtraction.getCurrent(
        reference.materialId
      );
      if (
        !candidate ||
        candidate.revisionId !== reference.materialRevisionId ||
        !isMaterialRevisionEligibleForSnapshot(candidate)
      ) {
        throw new Error(
          "A material source is stale or not approved for snapshot compilation."
        );
      }
      return {
        materialId: reference.materialId,
        materialRevisionId: reference.materialRevisionId,
        sourceChecksumSha256: candidate.sourceChecksumSha256,
      };
    })
  );
  const kmbById = new Map(input.kmbEntries.map((entry) => [entry.id, entry]));
  const kmbRefs = dedupeBy(
    input.statements.flatMap((statement) =>
      statement.sources
        .filter((source) => source.sourceType === "curated-kmb")
        .map((source) => source.sourceId)
    ),
    (id) => id
  ).map((entryId) => {
    const entry = kmbById.get(entryId);
    if (!entry || !entry.enabled) {
      throw new Error("A curated memory source is missing or disabled.");
    }
    return {
      entryId,
      contentHash: stablePreparationHash(entry.content),
    };
  });
  const evidenceIndex = dedupeBy(
    input.statements.flatMap((statement) =>
      statement.sources.map<PreparationSnapshotEvidenceIndexEntry>((source) => ({
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        title: source.title,
        contentHash:
          source.contentHash ??
          stablePreparationHash(
            stableJson({ statementId: statement.id, sourceId: source.sourceId })
          ),
        materialId: source.materialId,
        materialRevisionId: source.materialRevisionId,
        page: source.page,
        section: source.section,
      }))
    ),
    (item) => `${item.sourceType}\u0000${item.sourceId}\u0000${item.contentHash}`
  ).sort(sourceIndexOrder);
  if (evidenceIndex.length > MAX_EVIDENCE_INDEX_ITEMS) {
    throw new Error("Preparation source lineage exceeds the snapshot index budget.");
  }
  return {
    materials: materialCandidates.sort((left, right) =>
      left.materialId.localeCompare(right.materialId)
    ),
    kmbEntries: kmbRefs.sort((left, right) =>
      left.entryId.localeCompare(right.entryId)
    ),
    evidenceIndex,
  };
}

function isMaterialRevisionEligibleForSnapshot(
  candidate: Awaited<
    ReturnType<PreparationMaterialExtractionRepository["getCurrent"]>
  >
) {
  if (!candidate) return false;
  if (candidate.status === "ready") {
    return candidate.reviewStatus !== "needs-review";
  }
  return (
    candidate.status === "needs-review" &&
    candidate.reviewStatus === "approved"
  );
}

function compileEvidencePack(
  statements: PreparationStatementWithSources[]
): PreparationEvidenceItem[] {
  const evidence = statements
    .filter(
      (statement): statement is PreparationStatementWithSources & {
        domain: "candidate-fact" | "project-evidence";
        ownership: "candidate-owned" | "team-owned" | "upstream-existing" | "future-design";
      } =>
        ["candidate-fact", "project-evidence"].includes(statement.domain) &&
        statement.ownership !== "unresolved"
    )
    .map((statement) => ({
      statementId: statement.id,
      statementRevision: statement.revision,
      domain: statement.domain,
      content: statement.content,
      ownership: statement.ownership,
      allowedWording: statement.allowedWording,
      prohibitedWording: [...statement.prohibitedWording].sort(),
      allowedInterviewFamilies: [...statement.allowedInterviewFamilies].sort(),
      sourceIds: statement.sources.map((source) => source.sourceId).sort(),
    }));
  if (evidence.length > MAX_EVIDENCE_ITEMS) {
    throw new Error("Confirmed personal evidence exceeds the snapshot evidence budget.");
  }
  return evidence;
}

function compileSpeechBiasTerms(
  statements: PreparationStatementWithSources[],
  warnings: PreparationSnapshotWarning[]
): PreparationSpeechBiasTerm[] {
  const terms: PreparationSpeechBiasTerm[] = [];
  for (const statement of statements.filter(
    (candidate) => candidate.domain === "terminology"
  )) {
    const term = statement.content.replace(/\s+/gu, " ").trim();
    if (term.length > 120 || term.split(" ").length > 12) {
      warnings.push({
        code: "speech-bias-term-too-long",
        message: `Terminology statement ${statement.id} is too long for STT bias and was excluded.`,
        severity: "warning",
      });
      continue;
    }
    terms.push({
      canonicalTerm: term,
      aliases: [],
      statementId: statement.id,
      statementRevision: statement.revision,
      authority: "user-confirmed",
    });
  }
  if (terms.length > MAX_SPEECH_BIAS_TERMS) {
    throw new Error("Confirmed terminology exceeds the speech-bias term budget.");
  }
  return terms;
}

function compileNarrativePacks(graphs: PreparationNarrativeGraph[]): {
  narrativePack: PreparationNarrativePack;
  openingPack: PreparationOpeningPack;
  narrativeNodeRevisions: Map<string, number>;
} {
  const narrativeNodeRevisions = new Map<string, number>();
  const compiledGraphs = graphs.flatMap((graph) => {
    const nodes = graph.nodes
      .filter((node) => node.reviewStatus === "confirmed")
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((node) => {
        narrativeNodeRevisions.set(node.id, node.revision);
        return {
          nodeId: node.id,
          kind: node.kind,
          title: node.title,
          content: node.contentDraft,
          targetSeconds: node.targetSeconds,
          statementIds: [...node.statementIds].sort(),
        };
      });
    if (!nodes.length) return [];
    const nodeIds = new Set(nodes.map((node) => node.nodeId));
    return [
      {
        graphId: graph.id,
        graphRevision: graph.revision,
        subjectKind: graph.subjectKind,
        subjectId: graph.subjectId,
        nodes,
        edges: graph.edges
          .filter(
            (edge) =>
              nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId)
          )
          .map((edge) => ({
            fromNodeId: edge.fromNodeId,
            toNodeId: edge.toNodeId,
            relation: edge.relation,
          }))
          .sort((left, right) =>
            `${left.fromNodeId}:${left.toNodeId}:${left.relation}`.localeCompare(
              `${right.fromNodeId}:${right.toNodeId}:${right.relation}`
            )
          ),
      },
    ];
  });
  const openingItems = compiledGraphs.flatMap((graph) =>
    graph.nodes
      .filter((node) =>
        ["positioning", "intro-30s", "main-story-90s"].includes(node.kind)
      )
      .map((node) => ({
        graphId: graph.graphId,
        nodeId: node.nodeId,
        subjectKind: graph.subjectKind,
        subjectId: graph.subjectId,
        nodeKind: node.kind as "positioning" | "intro-30s" | "main-story-90s",
        title: node.title,
        renderedDraft: node.content,
        statementIds: node.statementIds,
      }))
  );
  return {
    narrativePack: { graphs: compiledGraphs },
    openingPack: { items: openingItems },
    narrativeNodeRevisions,
  };
}

function compilePlaybookOverlays(
  round: InterviewRound,
  profile: InterviewPreparationProfileRevision,
  evidence: PreparationEvidenceItem[]
): PreparationPlaybookOverlay[] {
  return [...round.expectedInterviewTypes]
    .sort()
    .flatMap((expectedInterviewType) => {
    const canonicalPlaybookId = playbookIdForType(expectedInterviewType);
    if (!canonicalPlaybookId) return [];
    return [
      {
        canonicalPlaybookId,
        expectedInterviewType,
        evidenceStatementIds: evidence
          .filter(
            (item) =>
              !item.allowedInterviewFamilies.length ||
              item.allowedInterviewFamilies.includes(expectedInterviewType)
          )
          .map((item) => item.statementId),
        companyCriteria: [...profile.content.companyGuidance],
        prohibitedOverclaims: uniqueStrings(
          evidence.flatMap((item) => item.prohibitedWording)
        ),
      },
    ];
    });
}

function playbookIdForType(type: PreparationExpectedInterviewType) {
  const mapping: Partial<Record<PreparationExpectedInterviewType, string>> = {
    behavioral: "behavioral_story",
    coding: "coding_algorithm",
    "general-system-design": "general_system_design",
    "ai-ml-system-design": "aiml_system_design",
    "project-deep-dive": "project_deep_dive",
    "field-knowledge": "aiml_field_knowledge",
  };
  return mapping[type];
}

export function diffPreparationSnapshots(
  next: InterviewPreparationSnapshot,
  previous?: InterviewPreparationSnapshot
): PreparationSnapshotDiffSection[] {
  const sections = [
    ["runtime-brief", "Runtime brief", next.runtimeBrief, previous?.runtimeBrief],
    ["strategy", "Strategy", next.strategy, previous?.strategy],
    ["evidence", "Evidence", next.evidencePack.items, previous?.evidencePack.items],
    ["speech-bias", "Speech bias", next.speechBiasTerms, previous?.speechBiasTerms],
    ["opening", "Opening pack", next.openingPack.items, previous?.openingPack.items],
    ["narratives", "Narratives", next.narrativePack.graphs, previous?.narrativePack.graphs],
    ["playbooks", "Playbook overlays", next.playbookOverlays, previous?.playbookOverlays],
    ["session-launch", "Session launch plan", next.sessionLaunchPlan, previous?.sessionLaunchPlan],
    ["warnings", "Warnings", next.warnings, previous?.warnings],
    ["evidence-index", "Evidence index", next.evidenceIndex, previous?.evidenceIndex],
    ["source-manifest", "Source manifest", next.sourceManifest, previous?.sourceManifest],
  ] as const;
  return sections.map(([id, label, nextValue, previousValue]) => {
    const unchanged =
      previous && stableJson(nextValue) === stableJson(previousValue);
    return {
      id,
      label,
      status: previous ? (unchanged ? "unchanged" : "changed") : "added",
      previousCount: countValue(previousValue),
      nextCount: countValue(nextValue),
      changes: unchanged
        ? []
        : describeSnapshotSectionChanges(id, nextValue, previousValue),
    };
  });
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function countValue(value: unknown) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return value === undefined ? 0 : 1;
}

function describeSnapshotSectionChanges(
  id: PreparationSnapshotDiffSection["id"],
  nextValue: unknown,
  previousValue: unknown
) {
  if (previousValue === undefined) return ["Added in the initial snapshot"];
  if (
    id === "runtime-brief" ||
    id === "strategy" ||
    id === "session-launch" ||
    id === "source-manifest"
  ) {
    const previous = previousValue as Record<string, unknown>;
    const next = nextValue as Record<string, unknown>;
    return Array.from(new Set([...Object.keys(previous), ...Object.keys(next)]))
      .sort()
      .filter((key) => stableJson(previous[key]) !== stableJson(next[key]))
      .map((key) => `Changed ${labelizeDiffKey(key)}`)
      .slice(0, 12);
  }
  const previousItems = Array.isArray(previousValue) ? previousValue : [];
  const nextItems = Array.isArray(nextValue) ? nextValue : [];
  const previousByKey = new Map(
    previousItems.map((item) => [snapshotItemKey(id, item), item])
  );
  const nextByKey = new Map(nextItems.map((item) => [snapshotItemKey(id, item), item]));
  const changes: string[] = [];
  for (const [key, item] of nextByKey) {
    if (!previousByKey.has(key)) {
      changes.push(`Added ${snapshotItemLabel(id, item)}`);
    } else if (stableJson(previousByKey.get(key)) !== stableJson(item)) {
      changes.push(`Changed ${snapshotItemLabel(id, item)}`);
    }
  }
  for (const [key, item] of previousByKey) {
    if (!nextByKey.has(key)) {
      changes.push(`Removed ${snapshotItemLabel(id, item)}`);
    }
  }
  return changes.slice(0, 12);
}

function snapshotItemKey(
  id: PreparationSnapshotDiffSection["id"],
  value: unknown
) {
  const item = value as Record<string, unknown>;
  switch (id) {
    case "evidence":
    case "speech-bias":
      return String(item.statementId ?? "");
    case "opening":
      return String(item.nodeId ?? "");
    case "narratives":
      return String(item.graphId ?? "");
    case "playbooks":
      return String(item.expectedInterviewType ?? "");
    case "warnings":
      return `${String(item.code ?? "")}\u0000${String(item.message ?? "")}`;
    case "evidence-index":
      return `${String(item.sourceType ?? "")}\u0000${String(item.sourceId ?? "")}`;
    default:
      return stableJson(value);
  }
}

function snapshotItemLabel(
  id: PreparationSnapshotDiffSection["id"],
  value: unknown
) {
  const item = value as Record<string, unknown>;
  switch (id) {
    case "evidence":
      return boundedLabel(String(item.content ?? item.statementId ?? "evidence"));
    case "speech-bias":
      return boundedLabel(String(item.canonicalTerm ?? "speech term"));
    case "opening":
      return boundedLabel(String(item.title ?? "opening item"));
    case "narratives":
      return boundedLabel(
        `${String(item.subjectKind ?? "narrative")}: ${String(item.subjectId ?? "")}`
      );
    case "playbooks":
      return boundedLabel(String(item.expectedInterviewType ?? "playbook"));
    case "warnings":
      return boundedLabel(String(item.message ?? item.code ?? "warning"));
    case "evidence-index":
      return boundedLabel(String(item.title ?? item.sourceId ?? "source"));
    default:
      return "item";
  }
}

function labelizeDiffKey(value: string) {
  return value.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase();
}

function boundedLabel(value: string) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 90 ? `${normalized.slice(0, 89)}…` : normalized;
}

function sameStringSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function statementOrder(
  left: PreparationStatementWithSources,
  right: PreparationStatementWithSources
) {
  return (
    left.domain.localeCompare(right.domain) ||
    left.normalizedContent.localeCompare(right.normalizedContent) ||
    left.id.localeCompare(right.id)
  );
}

function narrativeOrder(left: PreparationNarrativeGraph, right: PreparationNarrativeGraph) {
  return (
    left.subjectKind.localeCompare(right.subjectKind) ||
    left.subjectId.localeCompare(right.subjectId) ||
    left.revision - right.revision ||
    left.id.localeCompare(right.id)
  );
}

function sourceIndexOrder(
  left: PreparationSnapshotEvidenceIndexEntry,
  right: PreparationSnapshotEvidenceIndexEntry
) {
  return (
    left.sourceType.localeCompare(right.sourceType) ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.contentHash.localeCompare(right.contentHash)
  );
}

function dedupeBy<T>(items: T[], key: (item: T) => string) {
  const result: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const itemKey = key(item);
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);
    result.push(item);
  }
  return result;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function statementIdsByNormalizedContent(
  statements: PreparationStatementWithSources[]
) {
  const result = new Map<string, string[]>();
  for (const statement of statements) {
    const key = statement.content.trim().replace(/\s+/gu, " ").toLowerCase();
    result.set(key, [...(result.get(key) ?? []), statement.id].sort());
  }
  return result;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
