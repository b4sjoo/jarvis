import assert from "node:assert/strict";
import test from "node:test";
import {
  createNeutralPreparationRuntimeContext,
  loadPreparationRuntimeContext,
  toPreparationRuntimePresentation,
} from "../src/lib/meeting/preparation-runtime-context.js";
import { buildPreparationSnapshotArtifactManifest } from "../src/lib/preparation/snapshot-artifact-manifest.js";
import type {
  InterviewPreparationSnapshot,
  PreparationCurrentContext,
} from "../src/lib/preparation/snapshot-types.js";

test("a stable empty selection produces the neutral preparation mode", async () => {
  const selection: PreparationCurrentContext = {
    revision: 4,
    updatedAt: 100,
  };
  const context = await loadPreparationRuntimeContext({
    meetingSessionId: "meeting-1",
    preparationContextRevision: 1,
    loader: {
      readSelection: async () => selection,
      readSelectedSnapshot: async () => undefined,
    },
  });

  assert.equal(context.mode, "neutral");
  assert.equal(context.loadState, "neutral");
  assert.equal(context.selectionRevision, 4);
  assert.equal(context.projections, undefined);
  assert.equal(context.capabilities.runtimeReinforcement.enabled, false);
  assert.equal(context.capabilities.personalizedGuidance.enabled, false);
});

test("a selected snapshot is pinned through typed, provenance-bearing projections", async () => {
  const snapshot = createSnapshot();
  const selection = selectedContext(snapshot, 8);
  const poisonedSnapshot = {
    ...snapshot,
    trustedAdapterOnlySecret: "DO_NOT_LEAK_RAW_SNAPSHOT",
  } as InterviewPreparationSnapshot;
  const context = await loadPreparationRuntimeContext({
    meetingSessionId: "meeting-2",
    preparationContextRevision: 3,
    createdAt: 500,
    loader: {
      readSelection: async () => selection,
      readSelectedSnapshot: async () => poisonedSnapshot,
    },
  });

  assert.equal(context.mode, "prepared");
  assert.equal(context.loadState, "ready");
  assert.equal(context.pinnedSnapshot?.snapshotId, snapshot.id);
  assert.equal(context.pinnedSnapshot?.selectionRevision, 8);
  assert.equal(context.capabilities.runtimeReinforcement.enabled, false);
  assert.equal(context.capabilities.personalizedGuidance.enabled, false);
  assert.equal(
    context.projections?.lowImpact.programmingLanguage?.value,
    "Java"
  );
  assert.equal(
    context.projections?.personalized.factEvidence[0]?.value.content,
    "Built Agentic Memory APIs"
  );
  assert.ok(
    collectProjectionArtifactCounts(context).every((count) => count > 0)
  );
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.projections?.lowImpact), true);

  const serialized = JSON.stringify(context);
  assert.doesNotMatch(serialized, /DO_NOT_LEAK_RAW_SNAPSHOT/u);
  assert.doesNotMatch(serialized, /DO_NOT_EXPOSE_SESSION_LAUNCH/u);
  assert.doesNotMatch(serialized, /DO_NOT_EXPOSE_WARNING_TEXT/u);
});

test("selection races are retried and never pin a mismatched snapshot", async () => {
  const snapshot = createSnapshot();
  const first = selectedContext(snapshot, 2);
  const second = selectedContext(snapshot, 3);
  let selectionRead = 0;
  const context = await loadPreparationRuntimeContext({
    meetingSessionId: "meeting-3",
    preparationContextRevision: 7,
    loader: {
      readSelection: async () => {
        selectionRead += 1;
        return selectionRead === 1 ? first : second;
      },
      readSelectedSnapshot: async () => snapshot,
    },
  });

  assert.equal(context.mode, "prepared");
  assert.equal(context.selectionRevision, 3);
  assert.ok(selectionRead >= 4);
});

test("an inconsistent selected snapshot fails closed to neutral mode", async () => {
  const snapshot = createSnapshot();
  const selection = {
    ...selectedContext(snapshot, 5),
    selectedSnapshotId: "another-snapshot",
  };
  const context = await loadPreparationRuntimeContext({
    meetingSessionId: "meeting-4",
    preparationContextRevision: 9,
    loader: {
      readSelection: async () => selection,
      readSelectedSnapshot: async () => snapshot,
    },
  });

  assert.equal(context.mode, "neutral");
  assert.equal(context.loadState, "failed");
  assert.equal(
    context.loadFailure?.code,
    "selected-snapshot-mismatch"
  );
});

test("the public presentation exposes identity and counts but no preparation text", () => {
  const neutral = createNeutralPreparationRuntimeContext({
    meetingSessionId: "meeting-5",
    preparationContextRevision: 2,
  });
  const presentation = toPreparationRuntimePresentation(neutral);

  assert.equal(presentation.mode, "neutral");
  assert.deepEqual(presentation.projectionCounts, {
    lowImpact: 0,
    personalized: 0,
  });
  assert.equal("projections" in presentation, false);
});

function selectedContext(
  snapshot: InterviewPreparationSnapshot,
  revision: number
): PreparationCurrentContext {
  return {
    processId: snapshot.processId,
    roundId: snapshot.roundId,
    selectedSnapshotId: snapshot.id,
    revision,
    updatedAt: 400 + revision,
  };
}

function collectProjectionArtifactCounts(
  context: Awaited<ReturnType<typeof loadPreparationRuntimeContext>>
) {
  const low = context.projections?.lowImpact;
  const personalized = context.projections?.personalized;
  if (!low || !personalized) return [];
  return [
    low.runtimeBrief,
    low.questionTypePrior,
    ...(low.programmingLanguage ? [low.programmingLanguage] : []),
    ...low.speechBiasTerms,
    personalized.strategy,
    ...personalized.factEvidence,
    ...personalized.kmbEvidenceHints,
    ...personalized.openingItems,
    ...personalized.narrativeGraphs,
    ...personalized.playbookOverlays,
  ].map((projection) => projection.artifactRefs.length);
}

function createSnapshot(): InterviewPreparationSnapshot {
  const payload = {
    runtimeBrief: {
      company: "Snowflake",
      role: "Senior Software Engineer",
      roundId: "round-1",
      roundTitle: "Coding",
      stage: "coding" as const,
      expectedInterviewTypes: ["coding" as const],
      expectedTypePolicy: "restricted" as const,
      preferredProgrammingLanguage: "Java",
      focusAreas: ["graphs"],
      compactNotes: ["Prefer concise explanations"],
      unresolvedHighImpactAssumptions: [],
    },
    strategy: {
      priorities: ["Clarify before coding"],
      risks: ["Over-explaining"],
      questionsToAsk: ["What are the constraints?"],
      likelyBranches: ["Optimization follow-up"],
      timeAllocation: ["Five minutes for clarification"],
    },
    evidencePack: {
      items: [
        {
          statementId: "statement-1",
          statementRevision: 1,
          domain: "project-evidence" as const,
          content: "Built Agentic Memory APIs",
          ownership: "candidate-owned" as const,
          allowedWording: "I designed the API layer",
          prohibitedWording: ["I built the entire platform alone"],
          allowedInterviewFamilies: ["project-deep-dive"],
          sourceIds: ["material-1"],
        },
      ],
    },
    speechBiasTerms: [
      {
        canonicalTerm: "HNSW",
        aliases: ["H N S W"],
        statementId: "statement-1",
        statementRevision: 1,
        authority: "user-confirmed" as const,
      },
    ],
    openingPack: {
      items: [
        {
          graphId: "graph-1",
          nodeId: "node-1",
          subjectKind: "project" as const,
          subjectId: "agentic-memory",
          nodeKind: "positioning" as const,
          title: "Agentic Memory positioning",
          renderedDraft: "I built Agentic Memory for durable context.",
          statementIds: ["statement-1"],
        },
      ],
    },
    narrativePack: {
      graphs: [
        {
          graphId: "graph-1",
          graphRevision: 1,
          subjectKind: "project" as const,
          subjectId: "agentic-memory",
          nodes: [
            {
              nodeId: "node-1",
              kind: "positioning" as const,
              title: "Agentic Memory positioning",
              content: "Durable context for agents",
              statementIds: ["statement-1"],
            },
          ],
          edges: [],
        },
      ],
    },
    sessionLaunchPlan: {
      recommendedRuntimeConfiguration: {
        expectedInterviewTypes: ["coding" as const],
        expectedTypePolicy: "restricted" as const,
        preferredProgrammingLanguage: "Java",
      },
      smokeTests: ["DO_NOT_EXPOSE_SESSION_LAUNCH"],
      interviewFlow: ["Coding"],
      emergencyActions: ["Force Advise"],
      warnings: [],
      promptExcluded: true as const,
    },
    playbookOverlays: [
      {
        canonicalPlaybookId: "coding-v1",
        expectedInterviewType: "coding" as const,
        evidenceStatementIds: ["statement-1"],
        companyCriteria: ["Explain tradeoffs"],
        prohibitedOverclaims: ["Unsupported scale claims"],
      },
    ],
    evidenceIndex: [
      {
        sourceType: "curated-kmb" as const,
        sourceId: "kmb-1",
        title: "Agentic Memory APIs",
        contentHash: "kmb-hash",
      },
    ],
    sourceManifest: {
      process: { id: "process-1", contentHash: "process-hash" },
      round: { id: "round-1", contentHash: "round-hash" },
      profile: {
        id: "profile-1",
        revision: 1,
        contentHash: "profile-hash",
        sourceFingerprint: "profile-source",
      },
      statements: [
        { id: "statement-1", revision: 1, contentHash: "statement-hash" },
      ],
      narrativeNodes: [
        {
          graphId: "graph-1",
          graphRevision: 1,
          nodeId: "node-1",
          nodeRevision: 1,
        },
      ],
      materials: [],
      kmbEntries: [{ entryId: "kmb-1", contentHash: "kmb-hash" }],
      compilerVersion: "preparation-snapshot-v2",
      playbookRegistryVersion: "interview-playbook-v1",
      runtimeCapabilityVersion: "meeting-preparation-runtime-v1",
    },
    warnings: [
      {
        code: "private-warning",
        message: "DO_NOT_EXPOSE_WARNING_TEXT",
        severity: "warning" as const,
      },
    ],
  };
  const snapshotId = "snapshot-1";
  return {
    id: snapshotId,
    processId: "process-1",
    roundId: "round-1",
    version: 1,
    profileRevisionId: "profile-1",
    profileRevision: 1,
    compilerVersion: "preparation-snapshot-v2",
    playbookRegistryVersion: "interview-playbook-v1",
    runtimeCapabilityVersion: "meeting-preparation-runtime-v1",
    sourceFingerprint: "source-fingerprint",
    contentHash: "snapshot-content-hash",
    runtimeCharCount: 1_000,
    ...payload,
    artifactManifest: buildPreparationSnapshotArtifactManifest({
      snapshotId,
      payload,
    }),
    status: "active",
    createdAt: 100,
    activatedAt: 200,
  };
}
