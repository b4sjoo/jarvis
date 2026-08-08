import type { PreparationWorkspaceStatus } from "./types.js";

export const INTERVIEW_ROUND_STAGES = [
  "recruiter-screen",
  "hiring-manager",
  "behavioral",
  "coding",
  "general-system-design",
  "ai-ml-system-design",
  "project-deep-dive",
  "mixed",
  "other",
] as const;

export type InterviewRoundStage = (typeof INTERVIEW_ROUND_STAGES)[number];

export type PreparationExpectedInterviewType =
  | "behavioral"
  | "coding"
  | "general-system-design"
  | "ai-ml-system-design"
  | "project-deep-dive"
  | "field-knowledge"
  | "personal-logistics";

export type PreparationExpectedTypePolicy = "advisory" | "restricted";

export interface InterviewProcess {
  id: string;
  workspaceId: string;
  title: string;
  company?: string;
  role?: string;
  status: PreparationWorkspaceStatus;
  activeRoundId?: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export interface InterviewRound {
  id: string;
  processId: string;
  title: string;
  stage: InterviewRoundStage;
  customStageLabel?: string;
  expectedInterviewTypes: PreparationExpectedInterviewType[];
  expectedTypePolicy: PreparationExpectedTypePolicy;
  scheduledAt?: number;
  interviewerName?: string;
  interviewerRole?: string;
  preferredProgrammingLanguage?: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export interface InterviewProcessDetail {
  process: InterviewProcess;
  rounds: InterviewRound[];
}

export interface InterviewProcessRepository {
  insertProcess(process: InterviewProcess): Promise<void>;
  updateProcess(input: {
    previous: InterviewProcess;
    process: InterviewProcess;
  }): Promise<void>;
  getProcess(id: string): Promise<InterviewProcess | undefined>;
  listProcesses(input?: { includeArchived?: boolean }): Promise<InterviewProcess[]>;
  insertRound(round: InterviewRound): Promise<void>;
  updateRound(round: InterviewRound): Promise<void>;
  deleteRound(input: {
    processId: string;
    roundId: string;
    previousActiveRoundId?: string;
    nextActiveRoundId?: string;
    updatedAt: number;
  }): Promise<void>;
  getRound(id: string): Promise<InterviewRound | undefined>;
  listRounds(processId: string): Promise<InterviewRound[]>;
  setActiveRound(input: {
    processId: string;
    roundId: string;
    updatedAt: number;
  }): Promise<void>;
}

export interface InterviewRoundResourceDeletionLease {
  materialCount: number;
  conversationCount: number;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface InterviewRoundResourceLifecycle {
  stageDelete(input: {
    processId: string;
    roundId: string;
  }): Promise<InterviewRoundResourceDeletionLease>;
}

export interface PreparationWorkspaceLifecycle {
  create(input: { kind: "interview"; title: string }): Promise<{
    id: string;
    title: string;
    status: PreparationWorkspaceStatus;
    createdAt: number;
    updatedAt: number;
    archivedAt?: number;
  }>;
  archive(id: string): Promise<unknown>;
  reopen(id: string): Promise<unknown>;
  delete(id: string): Promise<void>;
}
