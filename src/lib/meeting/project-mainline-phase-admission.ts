import type { EffectiveQuestionSourceRecord } from "./effective-question-source-ledger.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import type { ProjectMainlinePhaseAdmission } from "./playbook-phase-contracts.js";
import type { AdvisorJobSource } from "./types.js";

export interface ProjectMainlinePhaseAdmissionInput {
  logicalQuestionUnit?: Pick<LogicalQuestionUnit, "id" | "sessionId">;
  effectiveRecords: readonly Pick<
    EffectiveQuestionSourceRecord,
    "sessionId" | "logicalQuestionUnitId" | "owner"
  >[];
  parentId?: string;
  responseOwner: ProjectMainlinePhaseAdmission["responseOwner"];
  source: AdvisorJobSource | "manual-screen";
  /** Includes final answer/owner admission and the original source/job's current
   * session, epoch, source, task/phase and manual-action bases. Never rebase an
   * old event to a new Back phase just to make this true.
   */
  authorized: boolean;
  freshParentCreated?: boolean;
  initializesSummary?: boolean;
  replay?: boolean;
  boundVoicePrimaryAsk?: boolean;
  projectSelection?: boolean;
}

/** Read the existing ledger before this operation's upsert; never consume or
 * create a question here. Commit and duplicate-operation receipts remain with
 * the caller's existing source-owned transaction, including concurrent calls.
 */
export function buildProjectMainlinePhaseAdmission(
  input: ProjectMainlinePhaseAdmissionInput
): ProjectMainlinePhaseAdmission | undefined {
  const question = input.logicalQuestionUnit;
  if (!question?.id || !question.sessionId || !input.parentId) return undefined;
  const records = input.effectiveRecords.filter(
    (record) => record.sessionId === question.sessionId
  );
  // A corrected revision and a failed generation still refer to an admitted Q.
  // Check identity across all owners, not the ledger's exact-revision lookup.
  const alreadyAdmitted = records.some(
    (record) => record.logicalQuestionUnitId === question.id
  );
  const previousMainline = [...records].reverse().find(
    (record) => record.owner.kind === "parent-mainline" &&
      record.owner.parentId === input.parentId
  );
  const initializesSummary = Boolean(input.freshParentCreated || input.initializesSummary);
  return {
    logicalQuestionUnitId: question.id,
    previousLogicalQuestionUnitId: previousMainline?.logicalQuestionUnitId,
    newQuestionAdmitted: Boolean(
      (input.source === "live-turn" || input.source === "manual-screen") &&
      !alreadyAdmitted &&
      !initializesSummary &&
      !input.replay &&
      !input.boundVoicePrimaryAsk &&
      !input.projectSelection
    ),
    parentId: input.parentId,
    responseOwner: { ...input.responseOwner },
    authorized: input.authorized,
    initializesSummary,
  };
}
