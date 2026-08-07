import assert from "node:assert/strict";
import test from "node:test";
import { createPreparationWorkspaceService } from "../src/lib/preparation/workspace-service.js";
import type {
  PreparationWorkspace,
  PreparationWorkspaceRepository,
  PreparationWorkspaceStorageGateway,
} from "../src/lib/preparation/types.js";

test("creates normalized workspace metadata and durable storage together", async () => {
  const harness = createHarness();
  const service = createPreparationWorkspaceService(harness.dependencies);

  const workspace = await service.create({
    kind: "interview",
    title: "  Snowflake   ML Interview  ",
  });

  assert.equal(workspace.id, "workspace-1");
  assert.equal(workspace.title, "Snowflake ML Interview");
  assert.equal(harness.workspaces.get(workspace.id)?.status, "active");
  assert.deepEqual(harness.storageEvents, [
    "ensure:interview:workspace-1",
  ]);
});

test("rolls back metadata when workspace storage cannot be created", async () => {
  const harness = createHarness({ failEnsure: true });
  const service = createPreparationWorkspaceService(harness.dependencies);

  await assert.rejects(
    service.create({ kind: "interview", title: "Broken workspace" }),
    /storage failed/
  );
  assert.equal(harness.workspaces.size, 0);
});

test("archive and reopen preserve workspace identity", async () => {
  const harness = createHarness();
  const service = createPreparationWorkspaceService(harness.dependencies);
  await service.create({ kind: "interview", title: "Process" });

  const archived = await service.archive("workspace-1");
  assert.equal(archived.status, "archived");
  assert.equal(archived.archivedAt, 1_002);

  const reopened = await service.reopen("workspace-1");
  assert.equal(reopened.status, "active");
  assert.equal(reopened.archivedAt, undefined);
});

test("hard delete stages files and restores them if metadata deletion fails", async () => {
  const harness = createHarness({ failDelete: true });
  const service = createPreparationWorkspaceService(harness.dependencies);
  await service.create({ kind: "interview", title: "Process" });

  await assert.rejects(service.delete("workspace-1"), /database delete failed/);
  assert.equal(harness.workspaces.get("workspace-1")?.status, "active");
  assert.deepEqual(harness.storageEvents, [
    "ensure:interview:workspace-1",
    "stage:interview:workspace-1",
    "restore:interview:workspace-1:delete-token",
  ]);
});

test("successful hard delete commits staged storage removal", async () => {
  const harness = createHarness();
  const service = createPreparationWorkspaceService(harness.dependencies);
  await service.create({ kind: "interview", title: "Process" });

  await service.delete("workspace-1");

  assert.equal(harness.workspaces.size, 0);
  assert.deepEqual(harness.storageEvents, [
    "ensure:interview:workspace-1",
    "stage:interview:workspace-1",
    "commit:interview:delete-token",
  ]);
});

function createHarness(options: { failEnsure?: boolean; failDelete?: boolean } = {}) {
  const workspaces = new Map<string, PreparationWorkspace>();
  const storageEvents: string[] = [];
  let timestamp = 1_000;

  const repository: PreparationWorkspaceRepository = {
    async insert(workspace) {
      workspaces.set(workspace.id, { ...workspace });
    },
    async get(id) {
      const workspace = workspaces.get(id);
      return workspace ? { ...workspace } : undefined;
    },
    async list(input = {}) {
      return [...workspaces.values()].filter(
        (workspace) =>
          (!input.kind || workspace.kind === input.kind) &&
          (input.includeArchived || workspace.status === "active")
      );
    },
    async setLifecycle(input) {
      const workspace = workspaces.get(input.id);
      if (!workspace) throw new Error("not found");
      workspaces.set(input.id, {
        ...workspace,
        status: input.status,
        updatedAt: input.updatedAt,
        archivedAt: input.archivedAt,
      });
    },
    async delete(id) {
      if (options.failDelete) throw new Error("database delete failed");
      workspaces.delete(id);
    },
  };

  const storage: PreparationWorkspaceStorageGateway = {
    async ensure(input) {
      storageEvents.push(`ensure:${input.kind}:${input.workspaceId}`);
      if (options.failEnsure) throw new Error("storage failed");
      return { relativeRoot: `${input.kind}/${input.workspaceId}`, created: true };
    },
    async stageDelete(input) {
      storageEvents.push(`stage:${input.kind}:${input.workspaceId}`);
      return { token: "delete-token" };
    },
    async restoreDelete(input) {
      storageEvents.push(
        `restore:${input.kind}:${input.workspaceId}:${input.token}`
      );
    },
    async commitDelete(input) {
      storageEvents.push(`commit:${input.kind}:${input.token}`);
    },
  };

  return {
    workspaces,
    storageEvents,
    dependencies: {
      repository,
      storage,
      now: () => ++timestamp,
      createId: () => "workspace-1",
    },
  };
}
