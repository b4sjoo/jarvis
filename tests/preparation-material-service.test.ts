import assert from "node:assert/strict";
import test from "node:test";
import type {
  InterviewProcessRepository,
  InterviewRound,
} from "../src/lib/preparation/interview-types.js";
import { createPreparationMaterialService } from "../src/lib/preparation/material-service.js";
import type {
  PreparationMaterial,
  PreparationMaterialRepository,
  PreparationMaterialStorageGateway,
  PreparationWorkspace,
  PreparationWorkspaceRepository,
} from "../src/lib/preparation/types.js";

test("imports an immutable process-scoped material with revision and source", async () => {
  const harness = createHarness();
  const service = createPreparationMaterialService(harness.dependencies);

  const outcomes = await service.importPaths({
    workspaceId: "workspace-1",
    sourcePaths: ["/selected/resume.pdf"],
    scope: { kind: "workspace" },
  });

  assert.equal(outcomes[0].status, "imported");
  const inserted = harness.inserted[0];
  assert.equal(inserted.material.originalFileName, "resume.pdf");
  assert.equal(inserted.material.scope.kind, "workspace");
  assert.equal(inserted.revision.revision, 1);
  assert.equal(inserted.revision.extractionStatus, "pending");
  assert.equal(inserted.sourceRef.sourceKind, "user-upload");
  assert.equal(inserted.sourceRef.contentHash, "checksum-resume");
  assert.deepEqual(harness.scheduledExtractions, ["workspace-1:id-1"]);
});

test("deduplicates matching content within one process and discards the copy", async () => {
  const existing = material({ id: "existing", checksumSha256: "checksum-resume" });
  const harness = createHarness({ existingMaterials: [existing] });
  const service = createPreparationMaterialService(harness.dependencies);

  const outcomes = await service.importPaths({
    workspaceId: "workspace-1",
    sourcePaths: ["/selected/resume.pdf"],
    scope: { kind: "workspace" },
  });

  assert.deepEqual(outcomes, [{ status: "duplicate", existing }]);
  assert.equal(harness.inserted.length, 0);
  assert.deepEqual(harness.storageEvents, [
    "import:id-1:/selected/resume.pdf",
    "stage:id-1",
    "commit:id-1--delete",
  ]);
});

test("rejects a round scope owned by another process before copying", async () => {
  const harness = createHarness({
    rounds: [round({ id: "foreign-round", processId: "workspace-2" })],
  });
  const service = createPreparationMaterialService(harness.dependencies);

  await assert.rejects(
    service.importPaths({
      workspaceId: "workspace-1",
      sourcePaths: ["/selected/resume.pdf"],
      scope: { kind: "round", roundId: "foreign-round" },
    }),
    /does not belong/
  );
  assert.deepEqual(harness.storageEvents, []);
});

test("keeps archived processes read-only", async () => {
  const harness = createHarness({ workspaceStatus: "archived" });
  const service = createPreparationMaterialService(harness.dependencies);

  await assert.rejects(
    service.importPaths({
      workspaceId: "workspace-1",
      sourcePaths: ["/selected/resume.pdf"],
      scope: { kind: "workspace" },
    }),
    /read-only/
  );
  assert.deepEqual(harness.storageEvents, []);
});

test("reassigns material scope without replacing its immutable original", async () => {
  const existing = material({ id: "material-1" });
  const harness = createHarness({ existingMaterials: [existing] });
  const service = createPreparationMaterialService(harness.dependencies);

  const updated = await service.updateScope("workspace-1", "material-1", {
    kind: "round",
    roundId: "round-1",
  });

  assert.deepEqual(updated.scope, { kind: "round", roundId: "round-1" });
  assert.equal(updated.id, existing.id);
  assert.equal(updated.checksumSha256, existing.checksumSha256);
  assert.equal(updated.storageRelativePath, existing.storageRelativePath);
  assert.deepEqual(harness.storageEvents, []);
});

test("rejects reassigning material scope to a round owned by another process", async () => {
  const existing = material({ id: "material-1" });
  const harness = createHarness({
    existingMaterials: [existing],
    rounds: [round({ id: "foreign-round", processId: "workspace-2" })],
  });
  const service = createPreparationMaterialService(harness.dependencies);

  await assert.rejects(
    service.updateScope("workspace-1", "material-1", {
      kind: "round",
      roundId: "foreign-round",
    }),
    /does not belong/
  );
  assert.deepEqual(harness.materials.get("material-1")?.scope, {
    kind: "workspace",
  });
});

test("restores file and metadata when material deletion cannot commit", async () => {
  const existing = material({ id: "material-1" });
  const harness = createHarness({
    existingMaterials: [existing],
    failStorageCommit: true,
  });
  const service = createPreparationMaterialService(harness.dependencies);

  await assert.rejects(
    service.delete("workspace-1", "material-1"),
    /storage commit failed/
  );

  assert.deepEqual(harness.storageEvents, [
    "stage:material-1",
    "commit:material-1--delete",
    "restore:material-1--delete",
  ]);
  assert.equal(harness.materials.get("material-1")?.status, "received");
});

test("keeps metadata deleted when a failed commit cannot restore storage", async () => {
  const existing = material({ id: "material-1" });
  const harness = createHarness({
    existingMaterials: [existing],
    failStorageCommit: true,
    failStorageRestore: true,
  });
  const service = createPreparationMaterialService(harness.dependencies);

  await assert.rejects(
    service.delete("workspace-1", "material-1"),
    /storage commit failed/
  );

  assert.deepEqual(harness.storageEvents, [
    "stage:material-1",
    "commit:material-1--delete",
    "restore:material-1--delete",
  ]);
  assert.equal(harness.materials.get("material-1")?.status, "deleted");
});

test("removes a copied file when database insertion fails", async () => {
  const harness = createHarness({ failInsert: true });
  const service = createPreparationMaterialService(harness.dependencies);

  const outcomes = await service.importPaths({
    workspaceId: "workspace-1",
    sourcePaths: ["/selected/resume.pdf"],
    scope: { kind: "workspace" },
  });

  assert.equal(outcomes[0].status, "failed");
  assert.deepEqual(harness.storageEvents, [
    "import:id-1:/selected/resume.pdf",
    "stage:id-1",
    "commit:id-1--delete",
  ]);
});

test("stages and commits deletion for round-scoped materials only", async () => {
  const roundMaterial = material({
    id: "round-material",
    scope: { kind: "round", roundId: "round-1" },
  });
  const processMaterial = material({ id: "process-material" });
  const harness = createHarness({
    existingMaterials: [roundMaterial, processMaterial],
  });
  const service = createPreparationMaterialService(harness.dependencies);

  const lease = await service.stageRoundDeletion("workspace-1", "round-1");
  assert.equal(lease.materialCount, 1);
  assert.equal(harness.materials.get("round-material")?.status, "deleted");
  assert.equal(harness.materials.get("process-material")?.status, "received");

  await lease.commit();
  assert.deepEqual(harness.storageEvents, [
    "stage:round-material",
    "commit:round-material--delete",
  ]);
});

test("restores staged round materials when the owner rolls deletion back", async () => {
  const roundMaterial = material({
    id: "round-material",
    scope: { kind: "round", roundId: "round-1" },
  });
  const harness = createHarness({ existingMaterials: [roundMaterial] });
  const service = createPreparationMaterialService(harness.dependencies);

  const lease = await service.stageRoundDeletion("workspace-1", "round-1");
  await lease.rollback();

  assert.equal(harness.materials.get("round-material")?.status, "received");
  assert.deepEqual(harness.storageEvents, [
    "stage:round-material",
    "restore:round-material--delete",
  ]);
});

test("attempts every round material restore after one restore fails", async () => {
  const first = material({
    id: "first",
    scope: { kind: "round", roundId: "round-1" },
  });
  const second = material({
    id: "second",
    scope: { kind: "round", roundId: "round-1" },
  });
  const harness = createHarness({
    existingMaterials: [first, second],
    failStorageRestoreFor: ["second"],
  });
  const service = createPreparationMaterialService(harness.dependencies);

  const lease = await service.stageRoundDeletion("workspace-1", "round-1");
  await assert.rejects(lease.rollback(), /Could not restore 1 staged round material/);

  assert.equal(harness.materials.get("first")?.status, "received");
  assert.equal(harness.materials.get("second")?.status, "deleted");
  assert.deepEqual(harness.storageEvents, [
    "stage:first",
    "stage:second",
    "restore:second--delete",
    "restore:first--delete",
  ]);
});

function createHarness(
  options: {
    workspaceStatus?: PreparationWorkspace["status"];
    existingMaterials?: PreparationMaterial[];
    rounds?: InterviewRound[];
    failInsert?: boolean;
    failStorageCommit?: boolean;
    failStorageRestore?: boolean;
    failStorageRestoreFor?: string[];
  } = {}
) {
  const workspace: PreparationWorkspace = {
    id: "workspace-1",
    kind: "interview",
    title: "Interview",
    status: options.workspaceStatus ?? "active",
    createdAt: 1,
    updatedAt: 1,
  };
  const materials = new Map(
    (options.existingMaterials ?? []).map((entry) => [entry.id, { ...entry }])
  );
  const rounds = new Map(
    (options.rounds ?? [round({})]).map((entry) => [entry.id, entry])
  );
  const inserted: Parameters<PreparationMaterialRepository["insert"]>[0][] = [];
  const storageEvents: string[] = [];
  const scheduledExtractions: string[] = [];
  let id = 0;
  let timestamp = 10;

  const workspaces: PreparationWorkspaceRepository = {
    async insert() {},
    async get(workspaceId) {
      return workspaceId === workspace.id ? { ...workspace } : undefined;
    },
    async list() {
      return [{ ...workspace }];
    },
    async setLifecycle() {},
    async delete() {},
  };

  const interviewProcesses: InterviewProcessRepository = {
    async insertProcess() {},
    async updateProcess() {},
    async getProcess() {
      return undefined;
    },
    async listProcesses() {
      return [];
    },
    async insertRound() {},
    async updateRound() {},
    async deleteRound() {},
    async getRound(roundId) {
      return rounds.get(roundId);
    },
    async listRounds(processId) {
      return [...rounds.values()].filter((entry) => entry.processId === processId);
    },
    async setActiveRound() {},
  };

  const materialRepository: PreparationMaterialRepository = {
    async insert(input) {
      if (options.failInsert) throw new Error("database insert failed");
      inserted.push(input);
      materials.set(input.material.id, { ...input.material });
    },
    async get(materialId) {
      const entry = materials.get(materialId);
      return entry ? { ...entry } : undefined;
    },
    async list(workspaceId) {
      return [...materials.values()].filter(
        (entry) => entry.workspaceId === workspaceId && entry.status !== "deleted"
      );
    },
    async findByChecksum(workspaceId, checksumSha256) {
      return [...materials.values()].find(
        (entry) =>
          entry.workspaceId === workspaceId &&
          entry.checksumSha256 === checksumSha256 &&
          entry.status !== "deleted"
      );
    },
    async updateScope(input) {
      const entry = materials.get(input.id);
      if (!entry || entry.workspaceId !== input.workspaceId) {
        throw new Error("not found");
      }
      materials.set(input.id, {
        ...entry,
        scope: input.scope,
        updatedAt: input.updatedAt,
      });
    },
    async setLifecycle(input) {
      const entry = materials.get(input.id);
      if (!entry) throw new Error("not found");
      materials.set(input.id, {
        ...entry,
        status: input.status,
        updatedAt: input.updatedAt,
        deletedAt: input.deletedAt,
      });
    },
  };

  const materialStorage: PreparationMaterialStorageGateway = {
    async import(input) {
      storageEvents.push(`import:${input.materialId}:${input.sourcePath}`);
      const baseName = input.sourcePath.split("/").pop() ?? "material.pdf";
      return {
        originalFileName: baseName,
        mimeType: "application/pdf",
        extension: "pdf",
        sizeBytes: 100,
        checksumSha256: baseName === "resume.pdf" ? "checksum-resume" : baseName,
        storageRelativePath: `interview-preparation/${input.workspaceId}/materials/${input.materialId}/original.pdf`,
      };
    },
    async stageDelete(input) {
      storageEvents.push(`stage:${input.materialId}`);
      return { token: `${input.materialId}--delete` };
    },
    async restoreDelete(input) {
      storageEvents.push(`restore:${input.token}`);
      if (
        options.failStorageRestore ||
        options.failStorageRestoreFor?.includes(input.materialId)
      ) {
        throw new Error("storage restore failed");
      }
    },
    async commitDelete(input) {
      storageEvents.push(`commit:${input.token}`);
      if (options.failStorageCommit) throw new Error("storage commit failed");
    },
  };

  return {
    inserted,
    materials,
    storageEvents,
    scheduledExtractions,
    dependencies: {
      materials: materialRepository,
      materialStorage,
      workspaces,
      interviewProcesses,
      extractionScheduler: {
        async schedule(workspaceId: string, materialId: string) {
          scheduledExtractions.push(`${workspaceId}:${materialId}`);
          return undefined;
        },
      },
      now: () => ++timestamp,
      createId: () => `id-${++id}`,
    },
  };
}

function material(
  overrides: Partial<PreparationMaterial>
): PreparationMaterial {
  return {
    id: "material-1",
    workspaceId: "workspace-1",
    scope: { kind: "workspace" },
    displayName: "resume.pdf",
    originalFileName: "resume.pdf",
    mimeType: "application/pdf",
    extension: "pdf",
    sizeBytes: 100,
    checksumSha256: "checksum-1",
    storageRelativePath:
      "interview-preparation/workspace-1/materials/material-1/original.pdf",
    status: "received",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function round(overrides: Partial<InterviewRound>): InterviewRound {
  return {
    id: "round-1",
    processId: "workspace-1",
    title: "Coding",
    stage: "coding",
    expectedInterviewTypes: ["coding"],
    expectedTypePolicy: "advisory",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
