import {
  decodeJson,
  encodeJson,
  loadPreparationDatabase,
  type SqlDatabase,
  withTransaction,
} from "./database.js";
import {
  CALL_PLAN_TRANSITIONS,
  CASE_TRANSITIONS,
  requireExpectedRevision,
  requireTransition,
} from "./state-machines.js";
import type {
  CallPlan,
  CallPlanState,
  CaseRecord,
  CaseRevision,
  CaseState,
} from "./types.js";

const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

interface CaseRow {
  id: string;
  title: string;
  status: CaseState;
  case_type: string | null;
  current_revision_id: string | null;
  row_revision: number;
  created_at: number;
  updated_at: number;
}

interface RevisionRow {
  id: string;
  case_id: string;
  revision: number;
  parent_revision_id: string | null;
  primary_objective: string;
  acceptable_fallbacks_json: string;
  party_ids_json: string;
  statement_ids_json: string;
  next_action_ids_json: string;
  source_command_id: string;
  created_at: number;
}

interface CallPlanRow {
  id: string;
  case_id: string;
  title: string;
  state: CallPlanState;
  objective: string;
  counterparty_ids_json: string;
  acceptable_outcomes_json: string;
  questions_to_ask_json: string;
  known_risks_json: string;
  scheduled_at: number | null;
  row_revision: number;
  created_at: number;
  updated_at: number;
}

const mapCase = (row: CaseRow): CaseRecord => ({
  id: row.id,
  title: row.title,
  status: row.status,
  caseType: row.case_type ?? undefined,
  currentRevisionId: row.current_revision_id ?? undefined,
  rowRevision: row.row_revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapRevision = (row: RevisionRow): CaseRevision => ({
  id: row.id,
  caseId: row.case_id,
  revision: row.revision,
  parentRevisionId: row.parent_revision_id ?? undefined,
  primaryObjective: row.primary_objective,
  acceptableFallbacks: decodeJson(row.acceptable_fallbacks_json, []),
  partyIds: decodeJson(row.party_ids_json, []),
  statementIds: decodeJson(row.statement_ids_json, []),
  nextActionIds: decodeJson(row.next_action_ids_json, []),
  sourceCommandId: row.source_command_id,
  createdAt: row.created_at,
});

const mapCallPlan = (row: CallPlanRow): CallPlan => ({
  id: row.id,
  caseId: row.case_id,
  title: row.title,
  state: row.state,
  objective: row.objective,
  counterpartyIds: decodeJson(row.counterparty_ids_json, []),
  acceptableOutcomes: decodeJson(row.acceptable_outcomes_json, []),
  questionsToAsk: decodeJson(row.questions_to_ask_json, []),
  knownRisks: decodeJson(row.known_risks_json, []),
  scheduledAt: row.scheduled_at ?? undefined,
  rowRevision: row.row_revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function createInitialCaseState(input: {
  title: string;
  primaryObjective: string;
  acceptableFallbacks?: string[];
  caseType?: string;
  now?: number;
}) {
  const title = input.title.trim();
  const objective = input.primaryObjective.trim();
  if (!title) throw new Error("Case title is required.");
  if (!objective) throw new Error("Primary objective is required.");
  const now = input.now ?? Date.now();
  const caseId = id("case");
  const revisionId = id("case_revision");
  const record: CaseRecord = {
    id: caseId,
    title,
    status: "open",
    caseType: input.caseType?.trim() || undefined,
    currentRevisionId: revisionId,
    rowRevision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const revision: CaseRevision = {
    id: revisionId,
    caseId,
    revision: 1,
    primaryObjective: objective,
    acceptableFallbacks: (input.acceptableFallbacks ?? [])
      .map((value) => value.trim())
      .filter(Boolean),
    partyIds: [],
    statementIds: [],
    nextActionIds: [],
    sourceCommandId: id("command"),
    createdAt: now,
  };
  return { record, revision };
}

export function createCallPlanState(input: {
  caseId: string;
  title: string;
  objective: string;
  acceptableOutcomes?: string[];
  questionsToAsk?: string[];
  knownRisks?: string[];
  scheduledAt?: number;
  now?: number;
}): CallPlan {
  const title = input.title.trim();
  const objective = input.objective.trim();
  if (!title) throw new Error("Call plan title is required.");
  if (!objective) throw new Error("Call plan objective is required.");
  const clean = (values?: string[]) =>
    (values ?? []).map((value) => value.trim()).filter(Boolean);
  const now = input.now ?? Date.now();
  return {
    id: id("call_plan"),
    caseId: input.caseId,
    title,
    state: "draft",
    objective,
    counterpartyIds: [],
    acceptableOutcomes: clean(input.acceptableOutcomes),
    questionsToAsk: clean(input.questionsToAsk),
    knownRisks: clean(input.knownRisks),
    scheduledAt: input.scheduledAt,
    rowRevision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export class CasePreparationService {
  constructor(private readonly database: SqlDatabase) {}

  static async open() {
    return new CasePreparationService(await loadPreparationDatabase());
  }

  async listCases() {
    const rows = await this.database.select<CaseRow[]>(
      "SELECT * FROM cases ORDER BY updated_at DESC"
    );
    return rows.map(mapCase);
  }

  async getCase(caseId: string) {
    const rows = await this.database.select<CaseRow[]>(
      "SELECT * FROM cases WHERE id = ?",
      [caseId]
    );
    return rows[0] ? mapCase(rows[0]) : null;
  }

  async getCurrentRevision(caseId: string) {
    const rows = await this.database.select<RevisionRow[]>(
      `SELECT revision.* FROM case_revisions revision
       JOIN cases item ON item.current_revision_id = revision.id
       WHERE item.id = ? AND revision.case_id = item.id`,
      [caseId]
    );
    return rows[0] ? mapRevision(rows[0]) : null;
  }

  async createCase(input: Parameters<typeof createInitialCaseState>[0]) {
    const created = createInitialCaseState(input);
    await withTransaction(this.database, async () => {
      await this.database.execute(
        `INSERT INTO cases (
          id, title, status, case_type, current_revision_id, row_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
        [
          created.record.id,
          created.record.title,
          created.record.status,
          created.record.caseType ?? null,
          created.record.rowRevision,
          created.record.createdAt,
          created.record.updatedAt,
        ]
      );
      await this.insertRevision(created.revision);
      const result = await this.database.execute(
        "UPDATE cases SET current_revision_id = ? WHERE id = ? AND current_revision_id IS NULL",
        [created.revision.id, created.record.id]
      );
      if (result.rowsAffected !== 1) {
        throw new Error("Case creation lost ownership before revision commit.");
      }
    });
    return created;
  }

  async updateCase(input: {
    caseId: string;
    expectedRevision: number;
    title: string;
    status: CaseState;
    caseType?: string;
  }) {
    const current = await this.getCase(input.caseId);
    if (!current) throw new Error("Case was not found.");
    requireExpectedRevision({
      entity: "Case",
      expected: input.expectedRevision,
      actual: current.rowRevision,
    });
    requireTransition({
      entity: "Case",
      from: current.status,
      to: input.status,
      allowed: CASE_TRANSITIONS,
    });
    if (!input.title.trim()) throw new Error("Case title is required.");
    const updatedAt = Date.now();
    const result = await this.database.execute(
      `UPDATE cases SET title = ?, status = ?, case_type = ?,
       row_revision = row_revision + 1, updated_at = ?
       WHERE id = ? AND row_revision = ?`,
      [
        input.title.trim(),
        input.status,
        input.caseType?.trim() || null,
        updatedAt,
        input.caseId,
        input.expectedRevision,
      ]
    );
    if (result.rowsAffected !== 1) throw new Error("Case revision conflict.");
    return this.getCase(input.caseId);
  }

  async createCallPlan(
    input: Parameters<typeof createCallPlanState>[0]
  ) {
    if (!(await this.getCase(input.caseId))) throw new Error("Case was not found.");
    const plan = createCallPlanState(input);
    await this.database.execute(
      `INSERT INTO call_plans (
        id, case_id, title, state, objective, counterparty_ids_json,
        acceptable_outcomes_json, questions_to_ask_json, known_risks_json,
        scheduled_at, row_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        plan.id,
        plan.caseId,
        plan.title,
        plan.state,
        plan.objective,
        encodeJson(plan.counterpartyIds),
        encodeJson(plan.acceptableOutcomes),
        encodeJson(plan.questionsToAsk),
        encodeJson(plan.knownRisks),
        plan.scheduledAt ?? null,
        plan.rowRevision,
        plan.createdAt,
        plan.updatedAt,
      ]
    );
    return plan;
  }

  async listCallPlans(caseId: string) {
    const rows = await this.database.select<CallPlanRow[]>(
      "SELECT * FROM call_plans WHERE case_id = ? ORDER BY updated_at DESC",
      [caseId]
    );
    return rows.map(mapCallPlan);
  }

  async updateCallPlan(input: {
    planId: string;
    expectedRevision: number;
    title: string;
    objective: string;
    state: CallPlanState;
    acceptableOutcomes: string[];
    questionsToAsk: string[];
    knownRisks: string[];
    scheduledAt?: number;
  }) {
    const rows = await this.database.select<CallPlanRow[]>(
      "SELECT * FROM call_plans WHERE id = ?",
      [input.planId]
    );
    if (!rows[0]) throw new Error("Call plan was not found.");
    const current = mapCallPlan(rows[0]);
    requireExpectedRevision({
      entity: "CallPlan",
      expected: input.expectedRevision,
      actual: current.rowRevision,
    });
    requireTransition({
      entity: "CallPlan",
      from: current.state,
      to: input.state,
      allowed: CALL_PLAN_TRANSITIONS,
    });
    const title = input.title.trim();
    const objective = input.objective.trim();
    if (!title || !objective) throw new Error("Call plan title and objective are required.");
    const clean = (values: string[]) => values.map((value) => value.trim()).filter(Boolean);
    const result = await this.database.execute(
      `UPDATE call_plans SET title = ?, objective = ?, state = ?,
       acceptable_outcomes_json = ?, questions_to_ask_json = ?, known_risks_json = ?,
       scheduled_at = ?, row_revision = row_revision + 1, updated_at = ?
       WHERE id = ? AND row_revision = ?`,
      [
        title,
        objective,
        input.state,
        encodeJson(clean(input.acceptableOutcomes)),
        encodeJson(clean(input.questionsToAsk)),
        encodeJson(clean(input.knownRisks)),
        input.scheduledAt ?? null,
        Date.now(),
        input.planId,
        input.expectedRevision,
      ]
    );
    if (result.rowsAffected !== 1) throw new Error("Call plan revision conflict.");
  }

  async deleteCallPlan(planId: string) {
    const result = await this.database.execute(
      "DELETE FROM call_plans WHERE id = ?",
      [planId]
    );
    if (result.rowsAffected !== 1) throw new Error("Call plan was not found.");
  }

  private async insertRevision(revision: CaseRevision) {
    await this.database.execute(
      `INSERT INTO case_revisions (
        id, case_id, revision, parent_revision_id, primary_objective,
        acceptable_fallbacks_json, party_ids_json, statement_ids_json,
        next_action_ids_json, source_command_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        revision.id,
        revision.caseId,
        revision.revision,
        revision.parentRevisionId ?? null,
        revision.primaryObjective,
        encodeJson(revision.acceptableFallbacks),
        encodeJson(revision.partyIds),
        encodeJson(revision.statementIds),
        encodeJson(revision.nextActionIds),
        revision.sourceCommandId,
        revision.createdAt,
      ]
    );
  }
}
