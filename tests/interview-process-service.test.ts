import assert from "node:assert/strict";
import test from "node:test";
import {
  createInterviewProcessService,
  formatRoundStageLabel,
} from "../src/lib/preparation/interview-process-service.js";
import type {
  InterviewProcess,
  InterviewProcessRepository,
  InterviewRound,
  InterviewRoundResourceLifecycle,
  PreparationWorkspaceLifecycle,
} from "../src/lib/preparation/interview-types.js";

test("creates a process with an initial active round", async () => {
  const harness = createHarness();
  const service = createInterviewProcessService(harness.dependencies);

  const detail = await service.create({
    title: "Snowflake Expertise Interview",
    company: "Snowflake",
    role: "Senior ML Engineer",
    initialRound: {
      stage: "project-deep-dive",
      title: "Expertise",
      scheduledAt: 2_000,
    },
  });

  assert.equal(detail.process.id, "workspace-1");
  assert.equal(detail.process.activeRoundId, "round-1");
  assert.equal(detail.rounds[0].title, "Expertise");
  assert.deepEqual(detail.rounds[0].expectedInterviewTypes, [
    "project-deep-dive",
    "field-knowledge",
    "behavioral",
  ]);
});

test("allows unresolved company and role without inventing values", async () => {
  const harness = createHarness();
  const service = createInterviewProcessService(harness.dependencies);

  const detail = await service.create({
    title: "Upcoming interview",
    initialRound: { stage: "other", customStageLabel: "Conversation" },
  });

  assert.equal(detail.process.company, undefined);
  assert.equal(detail.process.role, undefined);
  assert.deepEqual(detail.rounds[0].expectedInterviewTypes, []);
  assert.equal(formatRoundStageLabel(detail.rounds[0]), "Conversation");
});

test("requires and persists a custom label for Other rounds", async () => {
  const harness = createHarness();
  const service = createInterviewProcessService(harness.dependencies);

  await assert.rejects(
    service.create({ title: "Missing label", initialRound: { stage: "other" } }),
    /Custom stage/
  );
  const detail = await service.create({
    title: "Custom stage",
    initialRound: { stage: "other", customStageLabel: "Domain Expertise" },
  });

  assert.equal(detail.rounds[0].title, "Domain Expertise");
  assert.equal(detail.rounds[0].customStageLabel, "Domain Expertise");
});

test("rejects an active round owned by another process", async () => {
  const harness = createHarness();
  const service = createInterviewProcessService(harness.dependencies);
  const first = await service.create({
    title: "First",
    initialRound: { stage: "coding" },
  });
  const second = await service.create({
    title: "Second",
    initialRound: { stage: "behavioral" },
  });

  await assert.rejects(
    service.setActiveRound(first.process.id, second.rounds[0].id),
    /does not belong/
  );
});

test("adds and activates a later round without changing round semantics", async () => {
  const harness = createHarness();
  const service = createInterviewProcessService(harness.dependencies);
  const detail = await service.create({
    title: "Process",
    initialRound: { stage: "recruiter-screen" },
  });
  const next = await service.addRound(detail.process.id, {
    stage: "ai-ml-system-design",
    expectedTypePolicy: "restricted",
  });

  const updated = await service.setActiveRound(detail.process.id, next.id);
  assert.equal(updated.activeRoundId, next.id);
  assert.equal(next.stage, "ai-ml-system-design");
  assert.deepEqual(next.expectedInterviewTypes, [
    "ai-ml-system-design",
    "field-knowledge",
    "coding",
  ]);
});

test("numbers blank round titles and rejects normalized duplicates", async () => {
  const harness = createHarness();
  const service = createInterviewProcessService(harness.dependencies);
  const detail = await service.create({
    title: "Process",
    initialRound: { stage: "coding" },
  });

  const second = await service.addRound(detail.process.id, { stage: "coding" });
  assert.equal(detail.rounds[0].title, "Coding");
  assert.equal(second.title, "Coding 2");
  await assert.rejects(
    service.addRound(detail.process.id, {
      stage: "behavioral",
      title: "  CODING   2 ",
    }),
    /must be unique/
  );
});

test("edits process and round metadata without changing their identities", async () => {
  const harness = createHarness();
  const service = createInterviewProcessService(harness.dependencies);
  const detail = await service.create({
    title: "Typo",
    company: "Snowflak",
    initialRound: { stage: "coding" },
  });
  const process = await service.updateProcess(detail.process.id, {
    title: "Snowflake Interview",
    company: "Snowflake",
    role: "Senior ML Engineer",
  });
  const round = await service.updateRound(
    detail.process.id,
    detail.rounds[0].id,
    {
      title: "System Design",
      stage: "ai-ml-system-design",
      scheduledAt: 9_000,
    }
  );

  assert.equal(process.id, detail.process.id);
  assert.equal(process.title, "Snowflake Interview");
  assert.equal(round.id, detail.rounds[0].id);
  assert.equal(round.stage, "ai-ml-system-design");
  assert.equal(round.scheduledAt, 9_000);
  assert.deepEqual(round.expectedInterviewTypes, [
    "ai-ml-system-design",
    "field-knowledge",
    "coding",
  ]);
});

test("reloads the active process and its rounds from the repository", async () => {
  const harness = createHarness();
  const service = createInterviewProcessService(harness.dependencies);
  const created = await service.create({
    title: "Reloadable",
    initialRound: { stage: "recruiter-screen" },
  });
  const laterRound = await service.addRound(created.process.id, {
    stage: "coding",
  });
  await service.setActiveRound(created.process.id, laterRound.id);

  const reloaded = await service.get(created.process.id);

  assert.equal(reloaded?.process.activeRoundId, laterRound.id);
  assert.deepEqual(
    reloaded?.rounds.map((round) => round.stage),
    ["recruiter-screen", "coding"]
  );
});

test("deletes an active round, its resources, and selects the next round", async () => {
  const harness = createHarness();
  const service = createInterviewProcessService(harness.dependencies);
  const detail = await service.create({
    title: "Deletable",
    initialRound: { stage: "recruiter-screen" },
  });
  const coding = await service.addRound(detail.process.id, { stage: "coding" });

  const result = await service.deleteRound(
    detail.process.id,
    detail.rounds[0].id
  );
  const reloaded = await service.get(detail.process.id);

  assert.equal(result.activeRoundId, coding.id);
  assert.equal(result.deletedMaterialCount, 2);
  assert.equal(reloaded?.process.activeRoundId, coding.id);
  assert.deepEqual(reloaded?.rounds.map((round) => round.id), [coding.id]);
  assert.deepEqual(harness.roundResourceEvents, [
    `stage:${detail.rounds[0].id}`,
    `commit:${detail.rounds[0].id}`,
  ]);
});

test("rejects deleting the last round before staging resources", async () => {
  const harness = createHarness();
  const service = createInterviewProcessService(harness.dependencies);
  const detail = await service.create({
    title: "One round",
    initialRound: { stage: "coding" },
  });

  await assert.rejects(
    service.deleteRound(detail.process.id, detail.rounds[0].id),
    /keep at least one round/
  );
  assert.deepEqual(harness.roundResourceEvents, []);
});

test("rolls back staged round resources when round deletion fails", async () => {
  const harness = createHarness({ failRoundDelete: true });
  const service = createInterviewProcessService(harness.dependencies);
  const detail = await service.create({
    title: "Rollback",
    initialRound: { stage: "coding" },
  });
  await service.addRound(detail.process.id, { stage: "behavioral" });

  await assert.rejects(
    service.deleteRound(detail.process.id, detail.rounds[0].id),
    /round delete failed/
  );
  assert.deepEqual(harness.roundResourceEvents, [
    `stage:${detail.rounds[0].id}`,
    `rollback:${detail.rounds[0].id}`,
  ]);
});

test("removes the workspace when process creation cannot settle", async () => {
  const harness = createHarness({ failRoundInsert: true });
  const service = createInterviewProcessService(harness.dependencies);

  await assert.rejects(
    service.create({ title: "Broken", initialRound: { stage: "coding" } }),
    /round insert failed/
  );
  assert.deepEqual(harness.workspaceEvents, [
    "create:Broken",
    "delete:workspace-1",
  ]);
});

test("keeps archived interview processes read-only", async () => {
  const harness = createHarness();
  const service = createInterviewProcessService(harness.dependencies);
  const detail = await service.create({
    title: "Archived",
    initialRound: { stage: "coding" },
  });

  await service.archive(detail.process.id);

  await assert.rejects(
    service.addRound(detail.process.id, { stage: "behavioral" }),
    /read-only/
  );
  await assert.rejects(
    service.updateProcess(detail.process.id, {
      title: "Still archived",
    }),
    /read-only/
  );
  await assert.rejects(
    service.updateRound(detail.process.id, detail.rounds[0].id, {
      stage: "coding",
    }),
    /read-only/
  );
});

function createHarness(
  options: { failRoundInsert?: boolean; failRoundDelete?: boolean } = {}
) {
  const processes = new Map<string, InterviewProcess>();
  const rounds = new Map<string, InterviewRound>();
  const workspaceEvents: string[] = [];
  const roundResourceEvents: string[] = [];
  let workspaceId = 0;
  let roundId = 0;
  let timestamp = 1_000;

  const workspaces: PreparationWorkspaceLifecycle = {
    async create(input) {
      workspaceEvents.push(`create:${input.title}`);
      return {
        id: `workspace-${++workspaceId}`,
        title: input.title,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    },
    async archive(workspaceId) {
      workspaceEvents.push(`archive:${workspaceId}`);
      const process = processes.get(workspaceId);
      if (process) {
        processes.set(workspaceId, {
          ...process,
          status: "archived",
          archivedAt: ++timestamp,
        });
      }
    },
    async reopen(workspaceId) {
      workspaceEvents.push(`reopen:${workspaceId}`);
      const process = processes.get(workspaceId);
      if (process) {
        processes.set(workspaceId, {
          ...process,
          status: "active",
          archivedAt: undefined,
        });
      }
    },
    async delete(workspaceId) {
      workspaceEvents.push(`delete:${workspaceId}`);
      processes.delete(workspaceId);
    },
  };

  const repository: InterviewProcessRepository = {
    async insertProcess(process) {
      processes.set(process.id, { ...process });
    },
    async updateProcess(input) {
      processes.set(input.process.id, { ...input.process });
    },
    async getProcess(processId) {
      const process = processes.get(processId);
      return process ? { ...process } : undefined;
    },
    async listProcesses() {
      return [...processes.values()].map((process) => ({ ...process }));
    },
    async insertRound(round) {
      if (options.failRoundInsert) throw new Error("round insert failed");
      rounds.set(round.id, { ...round });
    },
    async updateRound(round) {
      rounds.set(round.id, { ...round });
    },
    async deleteRound(input) {
      if (options.failRoundDelete) throw new Error("round delete failed");
      rounds.delete(input.roundId);
      if (input.previousActiveRoundId === input.roundId) {
        const process = processes.get(input.processId);
        if (process) {
          processes.set(input.processId, {
            ...process,
            activeRoundId: input.nextActiveRoundId,
            updatedAt: input.updatedAt,
          });
        }
      }
    },
    async getRound(roundId) {
      const round = rounds.get(roundId);
      return round ? { ...round } : undefined;
    },
    async listRounds(processId) {
      return [...rounds.values()].filter(
        (round) => round.processId === processId
      );
    },
    async setActiveRound(input) {
      const process = processes.get(input.processId);
      if (!process) throw new Error("not found");
      processes.set(input.processId, {
        ...process,
        activeRoundId: input.roundId,
        updatedAt: input.updatedAt,
      });
    },
  };

  return {
    workspaceEvents,
    roundResourceEvents,
    dependencies: {
      repository,
      workspaces,
      roundResources: {
        async stageDelete(input) {
          roundResourceEvents.push(`stage:${input.roundId}`);
          return {
            materialCount: 2,
            conversationCount: 0,
            async commit() {
              roundResourceEvents.push(`commit:${input.roundId}`);
            },
            async rollback() {
              roundResourceEvents.push(`rollback:${input.roundId}`);
            },
          };
        },
      } satisfies InterviewRoundResourceLifecycle,
      now: () => ++timestamp,
      createId: () => `round-${++roundId}`,
    },
  };
}
