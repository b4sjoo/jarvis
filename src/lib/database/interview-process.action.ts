import type {
  InterviewProcess,
  InterviewProcessRepository,
  InterviewRound,
  InterviewRoundStage,
  PreparationExpectedInterviewType,
  PreparationExpectedTypePolicy,
} from "@/lib/preparation/interview-types";
import type { PreparationWorkspaceStatus } from "@/lib/preparation/types";
import { getDatabase } from "./config";

interface InterviewProcessRow {
  id: string;
  workspace_id: string;
  title: string;
  company: string | null;
  role: string | null;
  status: PreparationWorkspaceStatus;
  active_round_id: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface InterviewRoundRow {
  id: string;
  process_id: string;
  title: string;
  stage: InterviewRoundStage;
  expected_interview_types: string;
  expected_type_policy: PreparationExpectedTypePolicy;
  scheduled_at: number | null;
  interviewer_name: string | null;
  interviewer_role: string | null;
  preferred_programming_language: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

const PROCESS_SELECT = `
  SELECT p.id, p.workspace_id, w.title, p.company, p.role, w.status,
         p.active_round_id, p.created_at, p.updated_at, w.archived_at
  FROM interview_processes p
  JOIN preparation_workspaces w ON w.id = p.workspace_id`;

const EXPECTED_INTERVIEW_TYPES = new Set<PreparationExpectedInterviewType>([
  "behavioral",
  "coding",
  "general-system-design",
  "ai-ml-system-design",
  "project-deep-dive",
  "field-knowledge",
  "personal-logistics",
]);

export const interviewProcessRepository: InterviewProcessRepository = {
  async insertProcess(process) {
    const db = await getDatabase();
    await db.execute(
      `INSERT INTO interview_processes
        (id, workspace_id, company, role, active_round_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        process.id,
        process.workspaceId,
        process.company ?? null,
        process.role ?? null,
        process.activeRoundId ?? null,
        process.createdAt,
        process.updatedAt,
      ]
    );
  },

  async getProcess(id) {
    const db = await getDatabase();
    const rows = await db.select<InterviewProcessRow[]>(
      `${PROCESS_SELECT} WHERE p.id = ?`,
      [id]
    );
    return rows[0] ? mapProcessRow(rows[0]) : undefined;
  },

  async listProcesses(input = {}) {
    const db = await getDatabase();
    const where = input.includeArchived ? "" : "WHERE w.status = 'active'";
    const rows = await db.select<InterviewProcessRow[]>(
      `${PROCESS_SELECT} ${where} ORDER BY p.updated_at DESC`
    );
    return rows.map(mapProcessRow);
  },

  async insertRound(round) {
    const db = await getDatabase();
    await db.execute(
      `INSERT INTO interview_rounds
        (id, process_id, title, stage, expected_interview_types,
         expected_type_policy, scheduled_at, interviewer_name,
         interviewer_role, preferred_programming_language, created_at,
         updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        round.id,
        round.processId,
        round.title,
        round.stage,
        JSON.stringify(round.expectedInterviewTypes),
        round.expectedTypePolicy,
        round.scheduledAt ?? null,
        round.interviewerName ?? null,
        round.interviewerRole ?? null,
        round.preferredProgrammingLanguage ?? null,
        round.createdAt,
        round.updatedAt,
        round.archivedAt ?? null,
      ]
    );
  },

  async getRound(id) {
    const db = await getDatabase();
    const rows = await db.select<InterviewRoundRow[]>(
      "SELECT * FROM interview_rounds WHERE id = ?",
      [id]
    );
    return rows[0] ? mapRoundRow(rows[0]) : undefined;
  },

  async listRounds(processId) {
    const db = await getDatabase();
    const rows = await db.select<InterviewRoundRow[]>(
      `SELECT * FROM interview_rounds
       WHERE process_id = ? AND archived_at IS NULL
       ORDER BY scheduled_at IS NULL, scheduled_at ASC, created_at ASC`,
      [processId]
    );
    return rows.map(mapRoundRow);
  },

  async setActiveRound(input) {
    const db = await getDatabase();
    const result = await db.execute(
      `UPDATE interview_processes
       SET active_round_id = ?, updated_at = ?
       WHERE id = ?`,
      [input.roundId, input.updatedAt, input.processId]
    );
    if (result.rowsAffected === 0) {
      throw new Error("Interview process not found.");
    }
  },
};

function mapProcessRow(row: InterviewProcessRow): InterviewProcess {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    company: row.company ?? undefined,
    role: row.role ?? undefined,
    status: row.status,
    activeRoundId: row.active_round_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
  };
}

function mapRoundRow(row: InterviewRoundRow): InterviewRound {
  return {
    id: row.id,
    processId: row.process_id,
    title: row.title,
    stage: row.stage,
    expectedInterviewTypes: parseExpectedTypes(row.expected_interview_types),
    expectedTypePolicy: row.expected_type_policy,
    scheduledAt: row.scheduled_at ?? undefined,
    interviewerName: row.interviewer_name ?? undefined,
    interviewerRole: row.interviewer_role ?? undefined,
    preferredProgrammingLanguage:
      row.preferred_programming_language ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
  };
}

function parseExpectedTypes(value: string): PreparationExpectedInterviewType[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is PreparationExpectedInterviewType =>
          EXPECTED_INTERVIEW_TYPES.has(
            item as PreparationExpectedInterviewType
          )
        )
      : [];
  } catch {
    return [];
  }
}
