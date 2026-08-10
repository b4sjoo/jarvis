import assert from "node:assert/strict";
import test from "node:test";
import {
  PreparationRuntimeProvenanceError,
  PreparationRuntimeProvenanceLedger,
  buildPreparationAnswerAttributionIndex,
  selectPreparationArtifactUseReceiptsForEvaluation,
} from "../src/lib/meeting/preparation-runtime-provenance.js";
import type {
  PreparationRuntimeArtifactRef,
  PreparationRuntimeContext,
  PreparationRuntimeProjection,
} from "../src/lib/meeting/preparation-runtime-context.js";
import { updatePreparationRuntimeCapabilities } from "../src/lib/meeting/preparation-runtime-context.js";

test("a pinned context records no influence until a consumer emits a receipt", () => {
  const ledger = new PreparationRuntimeProvenanceLedger(createContext());

  assert.equal(ledger.listReceipts().length, 0);
  assert.equal(ledger.listEvaluations().length, 0);
  assert.equal(ledger.getAnswerAttributions().length, 0);
  assert.equal(ledger.getSnapshot().projectionCatalog.length, 4);
});

test("artifact use is joined to snapshot, trace, question, and answer lineage", () => {
  const context = createContext();
  const ledger = new PreparationRuntimeProvenanceLedger(context);
  const projection = required(context.projections?.lowImpact.runtimeBrief);
  const artifactId = projection.artifactRefs[0]!.artifactId;
  const receipts = ledger.recordUse({
    projection,
    usedArtifactIds: [artifactId],
    consumer: "runtime-brief",
    targetKind: "advisor-prompt",
    targetId: "advisor-prompt-1",
    traceId: "trace-1",
    questionId: "question-1",
    answerRevision: 4,
    generationLeaseId: "lease-1",
    createdAt: 200,
  });

  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.snapshotId, "snapshot-1");
  assert.equal(receipts[0]?.snapshotVersion, 3);
  assert.equal(receipts[0]?.selectionRevision, 9);
  assert.equal(receipts[0]?.artifactId, artifactId);
  assert.equal(receipts[0]?.generationLeaseId, "lease-1");
  assert.deepEqual(ledger.getAnswerAttributions(), [
    {
      meetingSessionId: "meeting-1",
      questionId: "question-1",
      answerRevision: 4,
      traceIds: ["trace-1"],
      receiptIds: [required(receipts[0]).receiptId],
      artifactIds: [artifactId],
      lineageKeys: [required(receipts[0]).lineageKey],
      consumers: ["runtime-brief"],
    },
  ]);
});

test("untraceable and stale projections are rejected before runtime influence", () => {
  const context = createContext();
  const ledger = new PreparationRuntimeProvenanceLedger(context);
  const projection = required(context.projections?.lowImpact.runtimeBrief);
  assert.throws(
    () =>
      ledger.recordUse({
        projection,
        usedArtifactIds: ["not-in-manifest"],
        consumer: "runtime-brief",
        targetKind: "advisor-prompt",
        targetId: "prompt-1",
        traceId: "trace-1",
      }),
    (error) =>
      error instanceof PreparationRuntimeProvenanceError &&
      error.code === "untraceable-artifact-use"
  );

  const staleProjection = {
    ...projection,
    preparationContextRevision: 1,
  };
  assert.throws(
    () =>
      ledger.recordUse({
        projection: staleProjection,
        usedArtifactIds: [projection.artifactRefs[0]!.artifactId],
        consumer: "runtime-brief",
        targetKind: "advisor-prompt",
        targetId: "prompt-1",
        traceId: "trace-1",
      }),
    (error) =>
      error instanceof PreparationRuntimeProvenanceError &&
      error.code === "stale-projection"
  );
  assert.equal(ledger.listReceipts().length, 0);
});

test("Speech Bias can only be attributed to its exact STT segment lineage", () => {
  const context = createContext();
  const ledger = new PreparationRuntimeProvenanceLedger(context);
  const projection = required(context.projections?.lowImpact.speechBiasTerms[0]);
  const artifactId = projection.artifactRefs[0]!.artifactId;

  assert.throws(
    () =>
      ledger.recordUse({
        projection,
        usedArtifactIds: [artifactId],
        consumer: "speech-bias",
        targetKind: "advisor-prompt",
        targetId: "prompt-1",
        traceId: "trace-1",
      }),
    (error) =>
      error instanceof PreparationRuntimeProvenanceError &&
      error.code === "speech-bias-stt-lineage-required"
  );

  const [receipt] = ledger.recordUse({
    projection,
    usedArtifactIds: [artifactId],
    consumer: "speech-bias",
    targetKind: "stt-segment",
    targetId: "audio-session-1:7",
    traceId: "trace-stt-7",
    sttSegmentLineage: {
      audioSessionId: "audio-session-1",
      sequence: 7,
      turnId: "turn-7",
    },
  });
  assert.equal(receipt?.answerRevision, null);
  assert.equal(receipt?.sttSegmentLineage?.sequence, 7);
});

test("human labels require an actual receipt and retain answer attribution", () => {
  const context = createContext();
  const ledger = new PreparationRuntimeProvenanceLedger(context);
  assert.throws(
    () =>
      ledger.recordEvaluation({
        receiptId: "missing-receipt",
        label: "polluting",
      }),
    /actual use receipt/u
  );

  const projection = required(context.projections?.personalized.strategy);
  const [receipt] = ledger.recordUse({
    projection,
    usedArtifactIds: [projection.artifactRefs[0]!.artifactId],
    consumer: "strategy",
    targetKind: "advisor-prompt",
    targetId: "prompt-2",
    traceId: "trace-2",
    questionId: "question-2",
    answerRevision: 5,
  });
  const evaluation = ledger.recordEvaluation({
    receiptId: required(receipt).receiptId,
    label: "over-constraining",
    note: "Forced the wrong branch",
    createdAt: 300,
  });

  assert.equal(evaluation.artifactId, receipt?.artifactId);
  assert.equal(evaluation.questionId, "question-2");
  assert.equal(evaluation.answerRevision, 5);
  assert.equal(evaluation.label, "over-constraining");
});

test("answer attribution excludes pre-answer STT receipts", () => {
  const context = createContext();
  const ledger = new PreparationRuntimeProvenanceLedger(context);
  const projection = required(context.projections?.lowImpact.speechBiasTerms[0]);
  ledger.recordUse({
    projection,
    usedArtifactIds: [projection.artifactRefs[0]!.artifactId],
    consumer: "speech-bias",
    targetKind: "stt-segment",
    targetId: "audio-1:1",
    traceId: "trace-1",
    sttSegmentLineage: { audioSessionId: "audio-1", sequence: 1 },
  });

  assert.deepEqual(
    buildPreparationAnswerAttributionIndex(ledger.listReceipts()),
    []
  );
});

test("evaluation selects only receipts from the visible trace or answer revision", () => {
  const context = createContext();
  const ledger = new PreparationRuntimeProvenanceLedger(context);
  const projection = required(context.projections?.personalized.strategy);
  const artifactId = projection.artifactRefs[0]!.artifactId;
  ledger.recordUse({
    projection,
    usedArtifactIds: [artifactId],
    consumer: "strategy",
    targetKind: "advisor-prompt",
    targetId: "prompt-current",
    traceId: "trace-current",
    questionId: "question-current",
    answerRevision: 4,
  });
  ledger.recordUse({
    projection,
    usedArtifactIds: [artifactId],
    consumer: "strategy",
    targetKind: "advisor-prompt",
    targetId: "prompt-same-answer",
    traceId: "trace-related",
    questionId: "question-current",
    answerRevision: 4,
  });
  ledger.recordUse({
    projection,
    usedArtifactIds: [artifactId],
    consumer: "strategy",
    targetKind: "advisor-prompt",
    targetId: "prompt-old-answer",
    traceId: "trace-old",
    questionId: "question-current",
    answerRevision: 3,
  });

  const selected = selectPreparationArtifactUseReceiptsForEvaluation({
    receipts: ledger.listReceipts(),
    traceId: "trace-current",
    questionId: "question-current",
    answerRevision: 4,
  });

  assert.deepEqual(
    selected.map((receipt) => receipt.targetId),
    ["prompt-current", "prompt-same-answer"]
  );
});

test("a capability revision preserves history and rejects the prior projection", () => {
  const context = createContext();
  const ledger = new PreparationRuntimeProvenanceLedger(context);
  const oldProjection = required(
    context.projections?.lowImpact.runtimeBrief
  );
  const artifactId = oldProjection.artifactRefs[0]!.artifactId;
  const [receipt] = ledger.recordUse({
    projection: oldProjection,
    usedArtifactIds: [artifactId],
    consumer: "runtime-brief",
    targetKind: "advisor-prompt",
    targetId: "prompt-before-toggle",
    traceId: "trace-before-toggle",
  });
  const updated = updatePreparationRuntimeCapabilities(context, {
    preparationContextRevision: 7,
    runtimeReinforcementEnabled: true,
  });
  ledger.updateContext(updated);

  assert.equal(ledger.listReceipts()[0]?.receiptId, receipt?.receiptId);
  assert.throws(
    () =>
      ledger.recordUse({
        projection: oldProjection,
        usedArtifactIds: [artifactId],
        consumer: "runtime-brief",
        targetKind: "advisor-prompt",
        targetId: "stale-prompt",
        traceId: "trace-after-toggle",
      }),
    /current context revision/u
  );

  const currentProjection = required(
    updated.projections?.lowImpact.runtimeBrief
  );
  assert.doesNotThrow(() =>
    ledger.recordUse({
      projection: currentProjection,
      usedArtifactIds: [artifactId],
      consumer: "runtime-brief",
      targetKind: "advisor-prompt",
      targetId: "current-prompt",
      traceId: "trace-after-toggle",
    })
  );
});

test("disabled preparation capabilities reject consumer receipts", () => {
  const context = createContext();
  const disabled = updatePreparationRuntimeCapabilities(context, {
    preparationContextRevision: 7,
    runtimeReinforcementEnabled: false,
    personalizedGuidanceEnabled: false,
  });
  const ledger = new PreparationRuntimeProvenanceLedger(disabled);
  const runtimeProjection = required(
    disabled.projections?.lowImpact.runtimeBrief
  );
  const strategyProjection = required(
    disabled.projections?.personalized.strategy
  );

  assert.throws(
    () =>
      ledger.recordUse({
        projection: runtimeProjection,
        usedArtifactIds: [runtimeProjection.artifactRefs[0]!.artifactId],
        consumer: "runtime-brief",
        targetKind: "advisor-prompt",
        targetId: "disabled-runtime-prompt",
        traceId: "trace-disabled-runtime",
      }),
    (error) =>
      error instanceof PreparationRuntimeProvenanceError &&
      error.code === "consumer-capability-disabled"
  );
  assert.throws(
    () =>
      ledger.recordUse({
        projection: strategyProjection,
        usedArtifactIds: [strategyProjection.artifactRefs[0]!.artifactId],
        consumer: "strategy",
        targetKind: "advisor-prompt",
        targetId: "disabled-strategy-prompt",
        traceId: "trace-disabled-strategy",
      }),
    (error) =>
      error instanceof PreparationRuntimeProvenanceError &&
      error.code === "consumer-capability-disabled"
  );
  assert.equal(ledger.listReceipts().length, 0);
});

function createContext(): PreparationRuntimeContext {
  const runtimeArtifact = artifact({
    artifactId: "artifact-runtime",
    lineageKey: "lineage-runtime",
    artifactPath: "runtime-brief/company",
    section: "runtime-brief",
  });
  const speechArtifact = artifact({
    artifactId: "artifact-speech",
    lineageKey: "lineage-speech",
    artifactPath: "speech-bias/statement-1",
    section: "speech-bias",
  });
  const strategyArtifact = artifact({
    artifactId: "artifact-strategy",
    lineageKey: "lineage-strategy",
    artifactPath: "strategy/priorities/one",
    section: "strategy",
  });
  const runtimeBrief = projection("runtime-brief", [runtimeArtifact], {
    company: "Snowflake",
    roundId: "round-1",
    roundTitle: "Coding",
    stage: "coding",
    expectedInterviewTypes: ["coding"],
    expectedTypePolicy: "restricted",
    focusAreas: [],
    compactNotes: [],
    unresolvedHighImpactAssumptions: [],
  });
  const questionTypePrior = projection(
    "question-type-prior",
    [runtimeArtifact],
    {
      expectedInterviewTypes: ["coding"],
      expectedTypePolicy: "restricted",
    }
  );
  const speechBias = projection("speech-bias:statement-1", [speechArtifact], {
    canonicalTerm: "HNSW",
    aliases: ["H N S W"],
    statementId: "statement-1",
    statementRevision: 1,
    authority: "user-confirmed",
  });
  const strategy = projection("strategy", [strategyArtifact], {
    priorities: ["Be concise"],
    risks: [],
    questionsToAsk: [],
    likelyBranches: [],
    timeAllocation: [],
  });
  return {
    version: "meeting-preparation-context-v1",
    meetingSessionId: "meeting-1",
    preparationContextRevision: 6,
    selectionRevision: 9,
    mode: "prepared",
    loadState: "ready",
    createdAt: 100,
    pinnedSnapshot: {
      snapshotId: "snapshot-1",
      processId: "process-1",
      roundId: "round-1",
      version: 3,
      contentHash: "snapshot-hash",
      compilerVersion: "compiler-1",
      playbookRegistryVersion: "playbook-1",
      runtimeCapabilityVersion: "runtime-1",
      selectionRevision: 9,
      selectedAt: 90,
      artifactManifest: {
        version: "preparation-artifact-manifest-v1",
        artifacts: [runtimeArtifact, speechArtifact, strategyArtifact],
      },
    },
    capabilities: {
      runtimeReinforcement: {
        version: "meeting-preparation-10b-v1",
        available: true,
        enabled: true,
      },
      personalizedGuidance: {
        version: "meeting-preparation-10c-v1",
        available: true,
        enabled: true,
        requiresRuntimeReinforcement: true,
      },
    },
    projections: {
      lowImpact: {
        runtimeBrief,
        questionTypePrior,
        speechBiasTerms: [speechBias],
      },
      personalized: {
        strategy,
        factEvidence: [],
        kmbEvidenceHints: [],
        openingItems: [],
        narrativeGraphs: [],
        playbookOverlays: [],
      },
    },
  } as PreparationRuntimeContext;
}

function artifact(input: {
  artifactId: string;
  lineageKey: string;
  artifactPath: string;
  section: PreparationRuntimeArtifactRef["section"];
}): PreparationRuntimeArtifactRef {
  return {
    ...input,
    contentHash: `${input.artifactId}-hash`,
    sourceRefs: [{ kind: "compiler", id: "compiler-1" }],
  };
}

function projection<T>(
  id: string,
  artifactRefs: PreparationRuntimeArtifactRef[],
  value: T
): PreparationRuntimeProjection<T> {
  return {
    projectionId: `snapshot-1:${id}`,
    snapshotId: "snapshot-1",
    preparationContextRevision: 6,
    value,
    artifactRefs,
  };
}

function required<T>(value: T | undefined): T {
  assert.ok(value);
  return value;
}
