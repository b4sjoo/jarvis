import assert from "node:assert/strict";
import test from "node:test";
import { createInterviewProcessService } from "../src/lib/preparation/interview-process-service.js";
import type {
  InterviewProcess,
  InterviewProcessRepository,
  InterviewRound,
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
    initialRound: { stage: "other" },
  });

  assert.equal(detail.process.company, undefined);
  assert.equal(detail.process.role, undefined);
  assert.deepEqual(detail.rounds[0].expectedInterviewTypes, []);
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
});

function createHarness(options: { failRoundInsert?: boolean } = {}) {
  const processes = new Map<string, InterviewProcess>();
  const rounds = new Map<string, InterviewRound>();
  const workspaceEvents: string[] = [];
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
    dependencies: {
      repository,
      workspaces,
      now: () => ++timestamp,
      createId: () => `round-${++roundId}`,
    },
  };
}
