import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryEntry } from "../src/lib/memory/types.js";
import { parseCuratedMemoryDraft } from "../src/lib/memory/parser.js";
import { createPreparationProfileSourceFingerprint } from "../src/lib/preparation/preparation-composition-service.js";
import {
  createPreparationSnapshotService,
  diffPreparationSnapshots,
  type PreparationSnapshotEvent,
} from "../src/lib/preparation/snapshot-service.js";
import type {
  PreparationExtractionCandidate,
  PreparationMaterialExtractionRepository,
} from "../src/lib/preparation/extraction-types.js";
import type {
  InterviewPreparationProfileRevision,
  PreparationCompositionRepository,
  PreparationStatementRepository,
  PreparationStatementWithSources,
} from "../src/lib/preparation/statement-types.js";
import type {
  InterviewPreparationSnapshot,
  PreparationSnapshotActivationEvent,
  PreparationSnapshotRepository,
} from "../src/lib/preparation/snapshot-types.js";

const PROCESS_ID = "process-1";
const ROUND_ID = "round-1";
const ROUND_SCOPE = { kind: "round" as const, roundId: ROUND_ID };

test("snapshot compiler reuses an identical immutable artifact", async () => {
  const fixture = createFixture();
  const first = await fixture.service.compile({
    processId: PROCESS_ID,
    roundId: ROUND_ID,
    profileRevisionId: fixture.profile.id,
  });
  const second = await fixture.service.compile({
    processId: PROCESS_ID,
    roundId: ROUND_ID,
    profileRevisionId: fixture.profile.id,
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.snapshot.id, first.snapshot.id);
  assert.equal(second.snapshot.version, 1);
  assert.equal(second.snapshot.status, "ready");
  assert.equal(fixture.snapshots.length, 1);
  assert.equal(second.snapshot.evidencePack.items[0]?.content, "Built memory APIs");
});

test("snapshot compiler serializes concurrent requests for one round", async () => {
  const fixture = createFixture();
  const [first, second] = await Promise.all([
    fixture.service.compile({
      processId: PROCESS_ID,
      roundId: ROUND_ID,
      profileRevisionId: fixture.profile.id,
    }),
    fixture.service.compile({
      processId: PROCESS_ID,
      roundId: ROUND_ID,
      profileRevisionId: fixture.profile.id,
    }),
  ]);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.snapshot.id, second.snapshot.id);
  assert.equal(fixture.snapshots.length, 1);
});

test("changed reviewed evidence compiles a new version and produces a bounded diff", async () => {
  const fixture = createFixture();
  const first = (
    await fixture.service.compile({
      processId: PROCESS_ID,
      roundId: ROUND_ID,
      profileRevisionId: fixture.profile.id,
    })
  ).snapshot;

  fixture.statements[0] = statement({
    id: "fact-1",
    revision: 2,
    content: "Built and shipped memory APIs",
  });
  fixture.profile = profile(fixture.statements, 2);
  const second = (
    await fixture.service.compile({
      processId: PROCESS_ID,
      roundId: ROUND_ID,
      profileRevisionId: fixture.profile.id,
    })
  ).snapshot;

  assert.equal(second.version, 2);
  assert.notEqual(second.contentHash, first.contentHash);
  const diff = diffPreparationSnapshots(second, first);
  assert.equal(diff.find((section) => section.id === "evidence")?.status, "changed");
  assert.equal(
    diff.find((section) => section.id === "runtime-brief")?.status,
    "unchanged"
  );
  const firstArtifact = first.artifactManifest.artifacts.find(
    (artifact) => artifact.artifactPath === "evidence/fact-1"
  );
  const secondArtifact = second.artifactManifest.artifacts.find(
    (artifact) => artifact.artifactPath === "evidence/fact-1"
  );
  assert.ok(firstArtifact);
  assert.ok(secondArtifact);
  assert.equal(firstArtifact.lineageKey, secondArtifact.lineageKey);
  assert.notEqual(firstArtifact.artifactId, secondArtifact.artifactId);
  assert.notEqual(firstArtifact.contentHash, secondArtifact.contentHash);
});

test("snapshot artifacts use stable semantic paths instead of array indexes", async () => {
  const fixture = createFixture();
  const snapshot = (
    await fixture.service.compile({
      processId: PROCESS_ID,
      roundId: ROUND_ID,
      profileRevisionId: fixture.profile.id,
    })
  ).snapshot;

  assert.ok(snapshot.artifactManifest.artifacts.length > 0);
  assert.ok(
    snapshot.artifactManifest.artifacts.every(
      (artifact) => !/(^|\/)\d+(\/|$)/u.test(artifact.artifactPath)
    )
  );
  assert.ok(
    snapshot.artifactManifest.artifacts.every(
      (artifact) => artifact.sourceRefs.length > 0
    )
  );
});

test("failed stale activation preserves the previously active snapshot", async () => {
  const fixture = createFixture();
  const first = (
    await fixture.service.compile({
      processId: PROCESS_ID,
      roundId: ROUND_ID,
      profileRevisionId: fixture.profile.id,
    })
  ).snapshot;
  await fixture.service.activate({
    processId: PROCESS_ID,
    roundId: ROUND_ID,
    snapshotId: first.id,
  });

  fixture.statements[0] = statement({
    id: "fact-1",
    revision: 2,
    content: "Built and shipped memory APIs",
  });
  fixture.profile = profile(fixture.statements, 2);
  const second = (
    await fixture.service.compile({
      processId: PROCESS_ID,
      roundId: ROUND_ID,
      profileRevisionId: fixture.profile.id,
    })
  ).snapshot;

  fixture.statements[0] = statement({
    id: "fact-1",
    revision: 3,
    content: "Built, shipped, and operated memory APIs",
  });
  fixture.profile = profile(fixture.statements, 3);
  await assert.rejects(
    fixture.service.activate({
      processId: PROCESS_ID,
      roundId: ROUND_ID,
      snapshotId: second.id,
    }),
    /pinned preparation statement/u
  );
  assert.equal(
    fixture.snapshots.find((snapshot) => snapshot.status === "active")?.id,
    first.id
  );
});

test("active snapshot can be explicitly deactivated without deleting it", async () => {
  const fixture = createFixture();
  const snapshot = (
    await fixture.service.compile({
      processId: PROCESS_ID,
      roundId: ROUND_ID,
      profileRevisionId: fixture.profile.id,
    })
  ).snapshot;
  await fixture.service.activate({
    processId: PROCESS_ID,
    roundId: ROUND_ID,
    snapshotId: snapshot.id,
  });

  const deactivated = await fixture.service.deactivate({
    processId: PROCESS_ID,
    roundId: ROUND_ID,
    snapshotId: snapshot.id,
  });

  assert.equal(deactivated.status, "ready");
  assert.equal(
    fixture.snapshots.find((item) => item.status === "active"),
    undefined
  );
  assert.equal(fixture.events.at(-1)?.action, "deactivated");
  assert.equal(fixture.events.at(-1)?.snapshotId, snapshot.id);
  assert.equal(fixture.serviceEvents.at(-1)?.selectionRevision, 2);

  const reactivated = await fixture.service.activate({
    processId: PROCESS_ID,
    roundId: ROUND_ID,
    snapshotId: snapshot.id,
  });
  assert.equal(reactivated.status, "active");
  assert.equal(fixture.events.at(-1)?.action, "reactivated");
  assert.equal(fixture.serviceEvents.at(-1)?.selectionRevision, 3);
});

test("activating outside the current Round requires explicit switch authority", async () => {
  const fixture = createFixture();
  await fixture.repository.setCurrentContext({
    processId: "other-process",
    roundId: "other-round",
    expectedRevision: 0,
    updatedAt: 1,
  });
  const snapshot = (
    await fixture.service.compile({
      processId: PROCESS_ID,
      roundId: ROUND_ID,
      profileRevisionId: fixture.profile.id,
    })
  ).snapshot;

  await assert.rejects(
    fixture.service.activate({
      processId: PROCESS_ID,
      roundId: ROUND_ID,
      snapshotId: snapshot.id,
    }),
    /Confirm the context switch/u
  );
  const active = await fixture.service.activate({
    processId: PROCESS_ID,
    roundId: ROUND_ID,
    snapshotId: snapshot.id,
    allowContextSwitch: true,
  });
  assert.equal(active.status, "active");
  assert.deepEqual(await fixture.service.getCurrentContext(), {
    processId: PROCESS_ID,
    roundId: ROUND_ID,
    selectedSnapshotId: snapshot.id,
    revision: 2,
    updatedAt: 101,
  });
});

test("changing the global current context emits a selection event", async () => {
  const fixture = createFixture();

  const context = await fixture.service.setCurrentContext({
    processId: PROCESS_ID,
    roundId: ROUND_ID,
  });

  assert.equal(context.processId, PROCESS_ID);
  assert.equal(context.roundId, ROUND_ID);
  assert.equal(
    fixture.serviceEvents.at(-1)?.name,
    "Preparation current context changed"
  );
  assert.equal(fixture.serviceEvents.at(-1)?.selectionRevision, 1);
});

test("older snapshot can roll back when its pinned authority remains valid", async () => {
  const fixture = createFixture();
  const first = (
    await fixture.service.compile({
      processId: PROCESS_ID,
      roundId: ROUND_ID,
      profileRevisionId: fixture.profile.id,
    })
  ).snapshot;
  await fixture.service.activate({
    processId: PROCESS_ID,
    roundId: ROUND_ID,
    snapshotId: first.id,
  });

  fixture.statements.push(
    statement({ id: "fact-2", revision: 1, content: "Reduced retrieval latency" })
  );
  fixture.profile = profile(fixture.statements, 2);
  const second = (
    await fixture.service.compile({
      processId: PROCESS_ID,
      roundId: ROUND_ID,
      profileRevisionId: fixture.profile.id,
    })
  ).snapshot;
  await fixture.service.activate({
    processId: PROCESS_ID,
    roundId: ROUND_ID,
    snapshotId: second.id,
  });

  const rolledBack = await fixture.service.activate({
    processId: PROCESS_ID,
    roundId: ROUND_ID,
    snapshotId: first.id,
  });

  assert.equal(rolledBack.id, first.id);
  assert.equal(rolledBack.status, "active");
  assert.equal(
    fixture.snapshots.find((item) => item.id === second.id)?.status,
    "superseded"
  );
  assert.equal(fixture.events.at(-1)?.action, "rolled-back");
  assert.equal(fixture.events.at(-1)?.previousSnapshotId, second.id);
});

test("candidate evidence without resolved user authority cannot compile", async () => {
  const fixture = createFixture();
  fixture.statements[0] = {
    ...fixture.statements[0]!,
    authority: "model-generated",
    ownership: "unresolved",
    sources: fixture.statements[0]!.sources.filter(
      (source) => source.sourceType !== "user-confirmation"
    ),
  };
  fixture.profile = profile(fixture.statements, 2);
  await assert.rejects(
    fixture.service.compile({
      processId: PROCESS_ID,
      roundId: ROUND_ID,
      profileRevisionId: fixture.profile.id,
    }),
    /resolved ownership and user confirmation/u
  );
  assert.equal(fixture.snapshots.length, 0);
});

test("stale material source blocks compilation before a snapshot is visible", async () => {
  const fixture = createFixture();
  fixture.statements.push(materialStatement());
  fixture.profile = profile(fixture.statements, 2);
  await assert.rejects(
    fixture.service.compile({
      processId: PROCESS_ID,
      roundId: ROUND_ID,
      profileRevisionId: fixture.profile.id,
    }),
    /stale or not approved/u
  );
  assert.equal(fixture.snapshots.length, 0);
});

test("ready material sources do not require redundant manual approval", async () => {
  const fixture = createFixture();
  fixture.statements.push(materialStatement());
  fixture.currentExtraction = extractionCandidate({
    status: "ready",
    reviewStatus: "unreviewed",
  });
  fixture.profile = profile(fixture.statements, 2);

  const result = await fixture.service.compile({
    processId: PROCESS_ID,
    roundId: ROUND_ID,
    profileRevisionId: fixture.profile.id,
  });

  assert.equal(result.created, true);
  assert.equal(result.snapshot.sourceManifest.materials.length, 1);
});

test("needs-review material sources require explicit approval", async () => {
  const fixture = createFixture();
  fixture.statements.push(materialStatement());
  fixture.currentExtraction = extractionCandidate({
    status: "needs-review",
    reviewStatus: "needs-review",
  });
  fixture.profile = profile(fixture.statements, 2);

  await assert.rejects(
    fixture.service.compile({
      processId: PROCESS_ID,
      roundId: ROUND_ID,
      profileRevisionId: fixture.profile.id,
    }),
    /stale or not approved/u
  );
  assert.equal(fixture.snapshots.length, 0);
});

test("user-approved needs-review material sources can compile", async () => {
  const fixture = createFixture();
  fixture.statements.push(materialStatement());
  fixture.currentExtraction = extractionCandidate({
    status: "needs-review",
    reviewStatus: "approved",
  });
  fixture.profile = profile(fixture.statements, 2);

  const result = await fixture.service.compile({
    processId: PROCESS_ID,
    roundId: ROUND_ID,
    profileRevisionId: fixture.profile.id,
  });

  assert.equal(result.created, true);
  assert.equal(result.snapshot.sourceManifest.materials[0]?.materialRevisionId, "revision-1");
});

test("legacy KMB statements remain visible but require new reviewed source references before compilation", async () => {
  const fixture = createFixture();
  const entry = parseCuratedMemoryDraft({ path: "kmb.md", content: "```yaml\nentries:\n  - id: memory-1\n    sourceIds: [source-1]\n    type: interview_framework\n    title: Memory\n    content: Current evidence\n```" }, 1).entries[0];
  assert.ok(entry);
  fixture.kmbEntries.push({ ...entry, contentRevision: 1, contentHash: "full-content-hash", sourceRevisions: { "source-1": 1 } });
  fixture.statements[0].sources = [{ id: "legacy-source", statementId: fixture.statements[0].id,
    sourceType: "curated-kmb", sourceId: "memory-1", title: "Memory", contentHash: "snippet-hash", createdAt: 1 }, ...fixture.statements[0].sources];
  fixture.profile = profile(fixture.statements, 2);
  await assert.rejects(fixture.service.compile({ processId: PROCESS_ID, roundId: ROUND_ID, profileRevisionId: fixture.profile.id }), /Create a new statement.*confirm/);
  assert.equal(fixture.statements[0].sources[0].kmbEntryRevision, undefined);
  assert.equal(fixture.statements[0].content, "Built memory APIs");
  // The existing proposal/review workflow creates a new, explicitly sourced statement.
  fixture.statements[0] = { ...fixture.statements[0], id: "reviewed-current-statement", sources: [{
    ...fixture.statements[0].sources[0], id: "current-source", statementId: "reviewed-current-statement", kmbEntryRevision: 1,
  }, { ...fixture.statements[0].sources[1], id: "current-confirmation", statementId: "reviewed-current-statement", sourceId: "reviewed-current-statement:1" }] };
  fixture.profile = profile(fixture.statements, 3);
  const compiled = (await fixture.service.compile({ processId: PROCESS_ID, roundId: ROUND_ID, profileRevisionId: fixture.profile.id })).snapshot;
  assert.equal(compiled.schemaVersion, 2);
  assert.deepEqual(compiled.sourceManifest.kmbEntries, [{ entryId: "memory-1", entryRevision: 1, contentHash: "full-content-hash" }]);
  await fixture.service.activate({ processId: PROCESS_ID, roundId: ROUND_ID, snapshotId: compiled.id });
  const legacy = { ...compiled, id: "legacy-snapshot", schemaVersion: 1, sourceManifest: { ...compiled.sourceManifest,
    kmbEntries: [{ entryId: "memory-1", contentHash: "legacy-body-hash" }] } };
  fixture.snapshots.push(legacy);
  assert.ok((await fixture.service.list({ processId: PROCESS_ID, roundId: ROUND_ID })).some((row) => row.id === legacy.id));
  await assert.rejects(fixture.service.activate({ processId: PROCESS_ID, roundId: ROUND_ID, snapshotId: legacy.id }), /legacy Snapshot.*available to view.*Create and confirm/);
  assert.equal(fixture.snapshots.find((row) => row.id === legacy.id)?.schemaVersion, 1);
  fixture.kmbEntries[0] = { ...fixture.kmbEntries[0], enabled: false };
  await assert.rejects(fixture.service.getCurrentSnapshotForRuntimePin(), /KMB source changed.*disabled/);
  assert.equal((await fixture.service.getCurrentSnapshot())?.id, compiled.id);
});

function createFixture() {
  const statements = [
    statement({ id: "fact-1", revision: 1, content: "Built memory APIs" }),
    {
      ...statement({ id: "strategy-1", revision: 1, content: "Lead with impact" }),
      domain: "strategy" as const,
    },
  ];
  let currentProfile = profile(statements, 1);
  let currentExtraction: PreparationExtractionCandidate | undefined;
  const snapshots: InterviewPreparationSnapshot[] = [];
  const events: PreparationSnapshotActivationEvent[] = [];
  const serviceEvents: PreparationSnapshotEvent[] = [];
  const repository = snapshotRepository(snapshots, events);
  const kmbEntries: MemoryEntry[] = [];
  let id = 0;
  const service = createPreparationSnapshotService({
    statements: statementRepository(statements),
    composition: compositionRepository(() => currentProfile),
    snapshots: repository,
    interviewProcesses: activeProcessRepository(),
    materialExtraction: extractionRepository(() => currentExtraction),
    getKmbEntries: async () => kmbEntries,
    now: () => 100 + id,
    createId: () => String(++id),
    onEvent: (event) => serviceEvents.push(event),
  });
  return {
    statements,
    kmbEntries,
    snapshots,
    events,
    serviceEvents,
    repository,
    service,
    get profile() {
      return currentProfile;
    },
    set profile(value: InterviewPreparationProfileRevision) {
      currentProfile = value;
    },
    get currentExtraction() {
      return currentExtraction;
    },
    set currentExtraction(value: PreparationExtractionCandidate | undefined) {
      currentExtraction = value;
    },
  };
}

function materialStatement(): PreparationStatementWithSources {
  return {
    ...statement({ id: "term-1", revision: 1, content: "Agentic Memory" }),
    domain: "terminology",
    sources: [
      {
        id: "material-source-1",
        statementId: "term-1",
        sourceType: "material-chunk",
        sourceId: "chunk-1",
        title: "Interview guide",
        materialId: "material-1",
        materialRevisionId: "revision-1",
        contentHash: "source-hash",
        createdAt: 2,
      },
    ],
  };
}

function extractionCandidate(input: {
  status: "ready" | "needs-review";
  reviewStatus: "unreviewed" | "needs-review" | "approved";
}): PreparationExtractionCandidate {
  return {
    workspaceId: "workspace-1",
    materialId: "material-1",
    extension: "pdf",
    revisionId: "revision-1",
    revision: 1,
    sourceChecksumSha256: "material-checksum",
    outputHash: "material-output-hash",
    status: input.status,
    reviewStatus: input.reviewStatus,
    qualitySignals: [],
  };
}

function statement(input: {
  id: string;
  revision: number;
  content: string;
}): PreparationStatementWithSources {
  return {
    id: input.id,
    processId: PROCESS_ID,
    scope: ROUND_SCOPE,
    domain: "project-evidence",
    content: input.content,
    normalizedContent: input.content.toLowerCase(),
    status: "confirmed",
    authority: "user-confirmed",
    ownership: "candidate-owned",
    prohibitedWording: [],
    allowedInterviewFamilies: ["project-deep-dive"],
    proposalOperationId: "operation-1",
    revision: input.revision,
    lastReviewAction: "confirmed",
    lastReviewActor: "user",
    createdAt: 1,
    updatedAt: input.revision,
    reviewedAt: input.revision,
    sources: [
      {
        id: `${input.id}-confirmation-${input.revision}`,
        statementId: input.id,
        sourceType: "user-confirmation",
        sourceId: `${input.id}:${input.revision}`,
        title: "User confirmation",
        createdAt: input.revision,
      },
    ],
  };
}

function profile(
  statements: PreparationStatementWithSources[],
  revision: number
): InterviewPreparationProfileRevision {
  const confirmed = statements.filter((item) => item.status === "confirmed");
  return {
    id: `profile-${revision}`,
    processId: PROCESS_ID,
    scope: ROUND_SCOPE,
    revision,
    sourceFingerprint: createPreparationProfileSourceFingerprint(confirmed),
    contentHash: `profile-hash-${revision}`,
    content: {
      logistics: [],
      evidence: confirmed
        .filter((item) => ["candidate-fact", "project-evidence"].includes(item.domain))
        .map((item) => item.content),
      terminology: [],
      strategy: confirmed
        .filter((item) => item.domain === "strategy")
        .map((item) => item.content),
      companyGuidance: [],
      interviewPolicy: [],
      questions: [],
      risks: [],
      other: [],
    },
    confirmedStatementIds: confirmed.map((item) => item.id),
    unresolvedStatementIds: [],
    createdAt: revision,
  };
}

function statementRepository(
  statements: PreparationStatementWithSources[]
): PreparationStatementRepository {
  return {
    async beginProposalOperation() {},
    async stageProposalBatch() {},
    async commitProposalOperation() {
      return true;
    },
    async settleProposalOperation() {},
    async list(input) {
      return statements.filter(
        (item) => !input.statuses?.length || input.statuses.includes(item.status)
      );
    },
    async get(_processId, statementId) {
      return statements.find((item) => item.id === statementId);
    },
    async listEvents() {
      return [];
    },
    async review() {
      return true;
    },
  };
}

function compositionRepository(
  getProfile: () => InterviewPreparationProfileRevision
): PreparationCompositionRepository {
  return {
    async getProfileByFingerprint() {
      return undefined;
    },
    async insertProfile() {},
    async getLatestProfile() {
      return getProfile();
    },
    async listProfiles() {
      return [getProfile()];
    },
    async nextNarrativeRevision() {
      return 1;
    },
    async insertNarrativeGraph() {},
    async listNarrativeGraphs() {
      return [];
    },
    async getNarrativeGraph() {
      return undefined;
    },
    async reviewNarrativeNode() {
      return true;
    },
  };
}

function snapshotRepository(
  snapshots: InterviewPreparationSnapshot[],
  events: PreparationSnapshotActivationEvent[]
): PreparationSnapshotRepository {
  let currentContext = {
    revision: 0,
    updatedAt: 0,
  } as Awaited<ReturnType<PreparationSnapshotRepository["getCurrentContext"]>>;
  return {
    async get(processId, snapshotId) {
      return snapshots.find(
        (snapshot) => snapshot.processId === processId && snapshot.id === snapshotId
      );
    },
    async getByContentHash(input) {
      return snapshots.find(
        (snapshot) =>
          snapshot.processId === input.processId &&
          snapshot.roundId === input.roundId &&
          snapshot.contentHash === input.contentHash
      );
    },
    async getActive(input) {
      return snapshots.find(
        (snapshot) =>
          snapshot.processId === input.processId &&
          snapshot.roundId === input.roundId &&
          snapshot.status === "active"
      );
    },
    async list(input) {
      return snapshots
        .filter(
          (snapshot) =>
            snapshot.processId === input.processId &&
            snapshot.roundId === input.roundId
        )
        .sort((left, right) => right.version - left.version);
    },
    async nextVersion(input) {
      return (
        Math.max(
          0,
          ...snapshots
            .filter(
              (snapshot) =>
                snapshot.processId === input.processId &&
                snapshot.roundId === input.roundId
            )
            .map((snapshot) => snapshot.version)
        ) + 1
      );
    },
    async getCurrentContext() {
      return { ...currentContext };
    },
    async setCurrentContext(input) {
      if (currentContext.revision !== input.expectedRevision) return false;
      if (
        currentContext.processId === input.processId &&
        currentContext.roundId === input.roundId
      ) {
        return true;
      }
      const previous = snapshots.find(
        (snapshot) => snapshot.id === currentContext.selectedSnapshotId
      );
      if (previous) previous.status = "ready";
      currentContext = {
        processId: input.processId,
        roundId: input.roundId,
        revision: currentContext.revision + 1,
        updatedAt: input.updatedAt,
      };
      return true;
    },
    async insert(input) {
      snapshots.push(input.snapshot);
    },
    async activate(input) {
      if (currentContext.revision !== input.expectedContextRevision) return false;
      const target = snapshots.find(
        (snapshot) =>
          snapshot.id === input.snapshotId &&
          snapshot.processId === input.processId &&
          snapshot.roundId === input.roundId &&
          snapshot.contentHash === input.expectedContentHash
      );
      if (!target) return false;
      const previous = snapshots.find(
        (snapshot) => snapshot.id === currentContext.selectedSnapshotId
      );
      if (previous?.id === target.id) return true;
      const reactivated =
        target.status === "superseded" || target.activatedAt !== undefined;
      const rolledBack = Boolean(previous && target.version < previous.version);
      if (previous && previous.id !== target.id) previous.status = "superseded";
      target.status = "active";
      target.activatedAt = input.activatedAt;
      currentContext = {
        processId: input.processId,
        roundId: input.roundId,
        selectedSnapshotId: target.id,
        revision: currentContext.revision + 1,
        updatedAt: input.activatedAt,
      };
      events.push({
        id: `event-${events.length + 1}`,
        processId: input.processId,
        roundId: input.roundId,
        snapshotId: target.id,
        previousSnapshotId: previous?.id,
        action: rolledBack
          ? "rolled-back"
          : reactivated
            ? "reactivated"
            : "activated",
        createdAt: input.activatedAt,
      });
      return true;
    },
    async deactivate(input) {
      if (currentContext.revision !== input.expectedContextRevision) return false;
      const target = snapshots.find(
        (snapshot) =>
          snapshot.id === input.snapshotId &&
          snapshot.processId === input.processId &&
          snapshot.roundId === input.roundId &&
          snapshot.status === "active"
      );
      if (!target) return false;
      target.status = "ready";
      currentContext = {
        processId: input.processId,
        roundId: input.roundId,
        revision: currentContext.revision + 1,
        updatedAt: input.deactivatedAt,
      };
      events.push({
        id: `event-${events.length + 1}`,
        processId: input.processId,
        roundId: input.roundId,
        snapshotId: target.id,
        previousSnapshotId: target.id,
        action: "deactivated",
        createdAt: input.deactivatedAt,
      });
      return true;
    },
    async listActivationEvents() {
      return events;
    },
    async listCurrentContextEvents() {
      return [];
    },
  };
}

function activeProcessRepository() {
  return {
    async insertProcess() {},
    async updateProcess() {},
    async getProcess() {
      return {
        id: PROCESS_ID,
        workspaceId: "workspace-1",
        title: "Snowflake interview",
        company: "Snowflake",
        role: "Senior Software Engineer",
        status: "active" as const,
        activeRoundId: ROUND_ID,
        createdAt: 1,
        updatedAt: 2,
      };
    },
    async listProcesses() {
      return [];
    },
    async insertRound() {},
    async updateRound() {},
    async deleteRound() {},
    async getRound() {
      return {
        id: ROUND_ID,
        processId: PROCESS_ID,
        title: "Expertise",
        stage: "project-deep-dive" as const,
        expectedInterviewTypes: ["project-deep-dive" as const],
        expectedTypePolicy: "restricted" as const,
        createdAt: 1,
        updatedAt: 2,
      };
    },
    async listRounds() {
      return [];
    },
    async setActiveRound() {},
  };
}

function extractionRepository(
  getCurrent: () => PreparationExtractionCandidate | undefined
): PreparationMaterialExtractionRepository {
  return {
    async getCurrent() {
      throw new Error("Snapshot authority must read the selected output, not the candidate.");
    },
    async getSelected() {
      return getCurrent();
    },
    async getRevision(_materialId, revisionId) {
      const candidate = getCurrent();
      return candidate?.revisionId === revisionId ? candidate : undefined;
    },
    async listRecoverable() {
      return [];
    },
    async claim() {
      return undefined;
    },
    async complete() {
      return false;
    },
    async fail() {
      return false;
    },
    async createDerivedRevision() {
      return undefined;
    },
    async discardDerivedRevision() {
      return false;
    },
    async setReviewState() {
      return false;
    },
    async listChunks() {
      return [];
    },
  };
}
