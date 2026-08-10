import type {
  InterviewProcess,
  InterviewProcessDetail,
  InterviewProcessRepository,
  InterviewRound,
  InterviewRoundResourceLifecycle,
  InterviewRoundStage,
  PreparationExpectedInterviewType,
  PreparationExpectedTypePolicy,
  PreparationWorkspaceLifecycle,
} from "./interview-types.js";
import { PREPARATION_EXPECTED_INTERVIEW_TYPES } from "./interview-types.js";

export interface CreateInterviewProcessInput {
  title: string;
  company?: string;
  role?: string;
  initialRound: CreateInterviewRoundInput;
}

export interface CreateInterviewRoundInput {
  title?: string;
  stage: InterviewRoundStage;
  customStageLabel?: string;
  expectedInterviewTypes?: PreparationExpectedInterviewType[];
  expectedTypePolicy?: PreparationExpectedTypePolicy;
  scheduledAt?: number;
  interviewerName?: string;
  interviewerRole?: string;
  preferredProgrammingLanguage?: string;
}

export interface UpdateInterviewProcessInput {
  title: string;
  company?: string;
  role?: string;
}

export interface UpdateInterviewRoundInput {
  title?: string;
  stage: InterviewRoundStage;
  customStageLabel?: string;
  expectedInterviewTypes?: PreparationExpectedInterviewType[];
  expectedTypePolicy?: PreparationExpectedTypePolicy;
  scheduledAt?: number;
}

export interface InterviewProcessServiceDependencies {
  repository: InterviewProcessRepository;
  workspaces: PreparationWorkspaceLifecycle;
  roundResources: InterviewRoundResourceLifecycle;
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
      let round: InterviewRound;
      try {
        round = createRoundRecord({
          processId: process.id,
          input: input.initialRound,
          id: createId(),
          timestamp,
          existingRounds: [],
        });
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
      const existingRounds = await dependencies.repository.listRounds(process.id);
      const round = createRoundRecord({
        processId: process.id,
        input,
        id: createId(),
        timestamp,
        existingRounds,
      });
      await dependencies.repository.insertRound(round);
      return round;
    },

    async updateProcess(processId: string, input: UpdateInterviewProcessInput) {
      const previous = await requireProcess(dependencies.repository, processId);
      requireActiveProcess(previous);
      const timestamp = now();
      const process: InterviewProcess = {
        ...previous,
        title: normalizeRequiredText(input.title, "Process title", 160),
        company: normalizeOptionalText(input.company, 120),
        role: normalizeOptionalText(input.role, 160),
        updatedAt: timestamp,
      };
      await dependencies.repository.updateProcess({ previous, process });
      return process;
    },

    async updateRound(
      processId: string,
      roundId: string,
      input: UpdateInterviewRoundInput
    ) {
      const [process, round, existingRounds] = await Promise.all([
        requireProcess(dependencies.repository, processId),
        dependencies.repository.getRound(roundId),
        dependencies.repository.listRounds(processId),
      ]);
      requireActiveProcess(process);
      if (!round || round.processId !== process.id) {
        throw new Error("Interview round does not belong to this process.");
      }
      const timestamp = now();
      const customStageLabel = normalizeCustomStageLabel(
        input.stage,
        input.customStageLabel
      );
      const updated: InterviewRound = {
        ...round,
        title: resolveRoundTitle(
          input.title,
          input.stage,
          customStageLabel,
          existingRounds.filter((entry) => entry.id !== round.id)
        ),
        stage: input.stage,
        customStageLabel,
        expectedInterviewTypes: resolveExpectedInterviewTypes({
          stage: input.stage,
          requested: input.expectedInterviewTypes,
          current:
            input.stage === round.stage ? round.expectedInterviewTypes : undefined,
        }),
        expectedTypePolicy:
          input.expectedTypePolicy ?? round.expectedTypePolicy,
        scheduledAt: input.scheduledAt,
        updatedAt: timestamp,
      };
      await dependencies.repository.updateRound(updated);
      return updated;
    },

    async deleteRound(processId: string, roundId: string) {
      const [process, round, rounds] = await Promise.all([
        requireProcess(dependencies.repository, processId),
        dependencies.repository.getRound(roundId),
        dependencies.repository.listRounds(processId),
      ]);
      requireActiveProcess(process);
      if (!round || round.processId !== process.id) {
        throw new Error("Interview round does not belong to this process.");
      }
      if (rounds.length <= 1) {
        throw new Error("An interview process must keep at least one round.");
      }

      const nextRound = rounds.find((entry) => entry.id !== round.id);
      const resources = await dependencies.roundResources.stageDelete({
        processId,
        roundId,
      });
      const timestamp = now();
      try {
        await dependencies.repository.deleteRound({
          processId,
          roundId,
          previousActiveRoundId: process.activeRoundId,
          nextActiveRoundId:
            process.activeRoundId === roundId
              ? nextRound?.id
              : process.activeRoundId,
          updatedAt: timestamp,
        });
      } catch (error) {
        try {
          await resources.rollback();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Round deletion failed and its resources could not be fully restored."
          );
        }
        throw error;
      }

      await resources.commit();
      return {
        deletedRoundId: roundId,
        activeRoundId:
          process.activeRoundId === roundId
            ? nextRound?.id
            : process.activeRoundId,
        deletedMaterialCount: resources.materialCount,
        deletedConversationCount: resources.conversationCount,
      };
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
  existingRounds: InterviewRound[];
}): InterviewRound {
  const customStageLabel = normalizeCustomStageLabel(
    input.input.stage,
    input.input.customStageLabel
  );
  return {
    id: input.id,
    processId: input.processId,
    title: resolveRoundTitle(
      input.input.title,
      input.input.stage,
      customStageLabel,
      input.existingRounds
    ),
    stage: input.input.stage,
    customStageLabel,
    expectedInterviewTypes: resolveExpectedInterviewTypes({
      stage: input.input.stage,
      requested: input.input.expectedInterviewTypes,
    }),
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

function resolveExpectedInterviewTypes(input: {
  stage: InterviewRoundStage;
  requested?: PreparationExpectedInterviewType[];
  current?: PreparationExpectedInterviewType[];
}) {
  if (input.stage !== "mixed") return expectedTypesForStage(input.stage);
  const allowed = new Set(PREPARATION_EXPECTED_INTERVIEW_TYPES);
  const values = Array.from(
    new Set((input.requested ?? input.current ?? expectedTypesForStage("mixed")).filter(
      (value) => allowed.has(value)
    ))
  ).sort();
  if (values.length < 2) {
    throw new Error("Mixed rounds must include at least two interview types.");
  }
  return values;
}

function resolveRoundTitle(
  title: string | undefined,
  stage: InterviewRoundStage,
  customStageLabel: string | undefined,
  existingRounds: InterviewRound[]
) {
  const explicit = normalizeOptionalText(title, 120);
  const existingKeys = new Set(
    existingRounds.map((round) => normalizeRoundTitleKey(round.title))
  );
  if (explicit) {
    if (existingKeys.has(normalizeRoundTitleKey(explicit))) {
      throw new Error("Round title must be unique within this interview process.");
    }
    return explicit;
  }

  const base = customStageLabel ?? formatRoundStage(stage);
  if (!existingKeys.has(normalizeRoundTitleKey(base))) return base;
  for (let suffix = 2; suffix <= existingRounds.length + 2; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!existingKeys.has(normalizeRoundTitleKey(candidate))) return candidate;
  }
  throw new Error("Could not generate a unique round title.");
}

function normalizeRoundTitleKey(title: string) {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
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

export function formatRoundStageLabel(
  round: Pick<InterviewRound, "stage" | "customStageLabel">
) {
  return round.customStageLabel ?? formatRoundStage(round.stage);
}

function normalizeCustomStageLabel(
  stage: InterviewRoundStage,
  customStageLabel: string | undefined
) {
  return stage === "other"
    ? normalizeRequiredText(customStageLabel ?? "", "Custom stage", 80)
    : undefined;
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
