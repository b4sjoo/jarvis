import type {
  InterviewProcess,
  InterviewProcessDetail,
  InterviewProcessRepository,
  InterviewRound,
  InterviewRoundStage,
  PreparationExpectedInterviewType,
  PreparationExpectedTypePolicy,
  PreparationWorkspaceLifecycle,
} from "./interview-types.js";

export interface CreateInterviewProcessInput {
  title: string;
  company?: string;
  role?: string;
  initialRound: CreateInterviewRoundInput;
}

export interface CreateInterviewRoundInput {
  title?: string;
  stage: InterviewRoundStage;
  expectedInterviewTypes?: PreparationExpectedInterviewType[];
  expectedTypePolicy?: PreparationExpectedTypePolicy;
  scheduledAt?: number;
  interviewerName?: string;
  interviewerRole?: string;
  preferredProgrammingLanguage?: string;
}

export interface InterviewProcessServiceDependencies {
  repository: InterviewProcessRepository;
  workspaces: PreparationWorkspaceLifecycle;
  now?: () => number;
  createId?: () => string;
}

export function createInterviewProcessService(
  dependencies: InterviewProcessServiceDependencies
) {
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? (() => crypto.randomUUID());

  return {
    async create(input: CreateInterviewProcessInput): Promise<InterviewProcessDetail> {
      const title = normalizeRequiredText(input.title, "Process title", 160);
      const workspace = await dependencies.workspaces.create({
        kind: "interview",
        title,
      });
      const timestamp = now();
      const process: InterviewProcess = {
        id: workspace.id,
        workspaceId: workspace.id,
        title,
        company: normalizeOptionalText(input.company, 120),
        role: normalizeOptionalText(input.role, 160),
        status: workspace.status,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const round = createRoundRecord({
        processId: process.id,
        input: input.initialRound,
        id: createId(),
        timestamp,
      });

      try {
        await dependencies.repository.insertProcess(process);
        await dependencies.repository.insertRound(round);
        await dependencies.repository.setActiveRound({
          processId: process.id,
          roundId: round.id,
          updatedAt: timestamp,
        });
      } catch (error) {
        await dependencies.workspaces.delete(workspace.id).catch(() => {});
        throw error;
      }

      return {
        process: { ...process, activeRoundId: round.id },
        rounds: [round],
      };
    },

    async list(includeArchived = false) {
      return dependencies.repository.listProcesses({ includeArchived });
    },

    async get(id: string): Promise<InterviewProcessDetail | undefined> {
      const process = await dependencies.repository.getProcess(id);
      if (!process) return undefined;
      return {
        process,
        rounds: await dependencies.repository.listRounds(id),
      };
    },

    async addRound(processId: string, input: CreateInterviewRoundInput) {
      const process = await requireProcess(dependencies.repository, processId);
      requireActiveProcess(process);
      const timestamp = now();
      const round = createRoundRecord({
        processId: process.id,
        input,
        id: createId(),
        timestamp,
      });
      await dependencies.repository.insertRound(round);
      return round;
    },

    async setActiveRound(processId: string, roundId: string) {
      const [process, round] = await Promise.all([
        requireProcess(dependencies.repository, processId),
        dependencies.repository.getRound(roundId),
      ]);
      requireActiveProcess(process);
      if (!round || round.processId !== process.id) {
        throw new Error("Interview round does not belong to this process.");
      }
      const timestamp = now();
      await dependencies.repository.setActiveRound({
        processId,
        roundId,
        updatedAt: timestamp,
      });
      return { ...process, activeRoundId: roundId, updatedAt: timestamp };
    },

    async archive(processId: string) {
      await requireProcess(dependencies.repository, processId);
      await dependencies.workspaces.archive(processId);
    },

    async reopen(processId: string) {
      await requireProcess(dependencies.repository, processId);
      await dependencies.workspaces.reopen(processId);
    },

    async delete(processId: string) {
      await requireProcess(dependencies.repository, processId);
      await dependencies.workspaces.delete(processId);
    },
  };
}

function createRoundRecord(input: {
  processId: string;
  input: CreateInterviewRoundInput;
  id: string;
  timestamp: number;
}): InterviewRound {
  return {
    id: input.id,
    processId: input.processId,
    title:
      normalizeOptionalText(input.input.title, 120) ??
      formatRoundStage(input.input.stage),
    stage: input.input.stage,
    expectedInterviewTypes:
      input.input.expectedInterviewTypes ?? expectedTypesForStage(input.input.stage),
    expectedTypePolicy: input.input.expectedTypePolicy ?? "advisory",
    scheduledAt: input.input.scheduledAt,
    interviewerName: normalizeOptionalText(input.input.interviewerName, 120),
    interviewerRole: normalizeOptionalText(input.input.interviewerRole, 120),
    preferredProgrammingLanguage: normalizeOptionalText(
      input.input.preferredProgrammingLanguage,
      80
    ),
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  };
}

export function expectedTypesForStage(
  stage: InterviewRoundStage
): PreparationExpectedInterviewType[] {
  switch (stage) {
    case "behavioral":
      return ["behavioral"];
    case "coding":
      return ["coding"];
    case "general-system-design":
      return ["general-system-design", "field-knowledge"];
    case "ai-ml-system-design":
      return ["ai-ml-system-design", "field-knowledge", "coding"];
    case "project-deep-dive":
      return ["project-deep-dive", "field-knowledge", "behavioral"];
    case "recruiter-screen":
      return ["personal-logistics", "project-deep-dive", "behavioral"];
    case "hiring-manager":
    case "mixed":
      return [
        "behavioral",
        "coding",
        "general-system-design",
        "ai-ml-system-design",
        "project-deep-dive",
        "field-knowledge",
        "personal-logistics",
      ];
    case "other":
      return [];
  }
}

export function formatRoundStage(stage: InterviewRoundStage) {
  return stage
    .split("-")
    .map((word) =>
      word === "ai" || word === "ml"
        ? word.toUpperCase()
        : `${word[0].toUpperCase()}${word.slice(1)}`
    )
    .join(" ")
    .replace("AI ML", "AI/ML");
}

function normalizeRequiredText(value: string, label: string, maxLength: number) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} must be 1-${maxLength} characters.`);
  }
  return normalized;
}

function normalizeOptionalText(value: string | undefined, maxLength: number) {
  if (!value?.trim()) return undefined;
  return normalizeRequiredText(value, "Value", maxLength);
}

async function requireProcess(repository: InterviewProcessRepository, id: string) {
  const process = await repository.getProcess(id);
  if (!process) throw new Error("Interview process not found.");
  return process;
}

function requireActiveProcess(process: InterviewProcess) {
  if (process.status !== "active") {
    throw new Error("Archived interview processes are read-only.");
  }
}
