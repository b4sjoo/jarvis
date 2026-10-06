import { CANONICAL_QUESTION_TYPES, type CanonicalQuestionType } from "./task-taxonomy.js";
import type { ManualCorrectionIntent } from "./manual-correction-intent.js";
import type { ManualRuntimeActionKind } from "./manual-runtime-action.js";
import type { HumanEvaluationObservedSnapshotV2 } from "./human-ground-truth-v2.js";
import type { SessionProcedureExpectedContract, SessionProcedureFileRef, SessionProcedureScreenInput, SessionProcedure } from "./session-procedure.js";
import type { RuntimeRegressionCompletion } from "./runtime-regression-completion.js";

export type RuntimeRegressionSourceInput =
  | { kind: "them-text" | "me-text"; text: string; durationMs?: number }
  | { kind: "screen-input"; screen: SessionProcedureScreenInput }
  | { kind: "type-correction"; correctedType: CanonicalQuestionType; correctionIntentKind: ManualCorrectionIntent["kind"] }
  | { kind: "term-correction"; text: string }
  | { kind: "term-correction-deactivation"; sourceTerm?: string; replacementTerm: string }
  | { kind: Exclude<ManualRuntimeActionKind, "type-correction"> };

export type RuntimeRegressionEnvironment = Record<string, string | number | boolean | null>;
export interface RuntimeRegressionScenarioManifest {
  schemaVersion: 1;
  id: string;
  revision: number;
  procedure: SessionProcedureFileRef;
  assetRoot: string;
  allowAbsoluteAssets: boolean;
  review: { status: "reviewed"; purpose: "regression" | "practice"; reviewedBy: string; preconditions: RuntimeRegressionEnvironment };
}

export interface RuntimeRegressionScenario {
  manifest: RuntimeRegressionScenarioManifest;
  procedure: SessionProcedure;
  inputs: readonly RuntimeRegressionSourceInput[];
}

const ACTIONS = new Set(["force-advise", "next-phase", "previous-phase", "narrow-context", "enhance-context", "regenerate", "regenerate-artifacts", "toggle-advise-pin", "clear-task"]);
const CORRECTIONS = new Set(["independent", "new-child", "continue-child", "retype-parent", "merge-first-child", "resume-parent", "merge-recent-parent"]);
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Replay object is invalid.");
  return value as Record<string, any>;
};
function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Replay ${label} is missing.`);
  return value;
}
function fileRef(value: unknown): SessionProcedureFileRef {
  const item = object(value);
  const file = { path: nonempty(item.path, "file path"), sha256: nonempty(item.sha256, "file digest"), mediaType: item.mediaType };
  if (!/^sha256:[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Replay file digest is invalid.");
  if (file.mediaType !== undefined && typeof file.mediaType !== "string") throw new Error("Replay media type is invalid.");
  return file;
}

export function readRuntimeRegressionScenarioManifest(value: unknown): RuntimeRegressionScenarioManifest {
  const raw = object(value), review = object(raw.review);
  if (raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || review.status !== "reviewed" ||
    !["regression", "practice"].includes(review.purpose)) throw new Error("Replay scenario version/review is invalid.");
  const preconditions = object(review.preconditions);
  if (!Object.keys(preconditions).length || Object.values(preconditions).some(value =>
    value !== null && !["string", "number", "boolean"].includes(typeof value))) throw new Error("Replay preconditions must be explicit scalar fields.");
  return { schemaVersion: 1, id: nonempty(raw.id, "scenario id"), revision: raw.revision, procedure: fileRef(raw.procedure),
    assetRoot: nonempty(raw.assetRoot, "asset root"), allowAbsoluteAssets: raw.allowAbsoluteAssets === true,
    review: { status: "reviewed", purpose: review.purpose, reviewedBy: nonempty(review.reviewedBy, "reviewer"), preconditions } };
}

export function assertRuntimeRegressionPreconditions(expected: RuntimeRegressionEnvironment, actual: RuntimeRegressionEnvironment) {
  for (const [key, value] of Object.entries(expected)) {
    if (!Object.hasOwn(actual, key) || actual[key] !== value) throw new Error(`Replay prerequisite mismatch: ${key}.`);
  }
}

// Construct a fresh allowlisted input. Never forward a Procedure step, Expected,
// historical owner IDs or an old Correction target into the production entry.
export function readRuntimeRegressionSourceInput(value: unknown): RuntimeRegressionSourceInput {
  const step = object(value), input = object(step.input);
  if (Object.hasOwn(step, "targetStepId") || Object.hasOwn(input, "targetStepId")) throw new Error("Replay targetStepId is forbidden.");
  if (step.kind === "them-text" || step.kind === "me-text") {
    if (input.durationMs !== undefined && (!Number.isFinite(input.durationMs) || input.durationMs < 0)) throw new Error("Replay duration is invalid.");
    return { kind: step.kind, text: nonempty(input.text, "text"), durationMs: input.durationMs };
  }
  if (step.kind === "screen-input") {
    const screen = object(input.screen);
    return { kind: step.kind, screen: { image: fileRef(screen.image), focusImage: screen.focusImage ? fileRef(screen.focusImage) : undefined,
      metadata: screen.metadata ? fileRef(screen.metadata) : undefined } };
  }
  if (step.kind === "type-correction") {
    const kind = input.correctionIntentKind ?? input.correctionIntent?.kind;
    if (!CANONICAL_QUESTION_TYPES.includes(input.correctedType) || !CORRECTIONS.has(kind)) throw new Error("Replay correction intent/type is unsupported.");
    return { kind: step.kind, correctedType: input.correctedType, correctionIntentKind: kind };
  }
  if (step.kind === "term-correction") return { kind: step.kind, text: nonempty(input.correctionText ?? input.text, "correction text") };
  if (step.kind === "term-correction-deactivation") return { kind: step.kind,
    sourceTerm: input.sourceTerm === undefined ? undefined : nonempty(input.sourceTerm, "source term"),
    replacementTerm: nonempty(input.replacementTerm, "replacement term") };
  if (ACTIONS.has(step.kind)) return { kind: step.kind } as RuntimeRegressionSourceInput;
  throw new Error(`Unsupported replay input: ${String(step.kind)}.`);
}

export function readRuntimeRegressionScenario(manifest: RuntimeRegressionScenarioManifest, value: unknown): RuntimeRegressionScenario {
  const procedure = object(value);
  const source = object(procedure.source);
  nonempty(procedure.id, "Procedure id");
  nonempty(source.recordingSessionId, "source recording id");
  nonempty(source.folderName, "source folder");
  nonempty(source.sourceDigest, "source evidence digest");
  if (procedure.schemaVersion === 1 ? source.scriptedValidation !== true || typeof source.forcedScripted !== "boolean"
    : procedure.schemaVersion !== 2 || typeof source.originalScriptedValidation !== "boolean" || typeof source.originalForcedScripted !== "boolean") throw new Error("Replay source provenance is invalid.");
  if (procedure.execution?.defaultBarrier !== "typed-terminal" || !Array.isArray(procedure.steps) || !procedure.steps.length)
    throw new Error("Replay Procedure version/barrier/steps are invalid.");
  if (Object.keys(procedure.execution).some(key => key !== "defaultBarrier")) throw new Error("Replay execution mode is unsupported.");
  const ids = new Set<string>();
  const inputs = procedure.steps.map((step: any, index: number) => {
    nonempty(step.id, "step id");
    if (step.waitFor !== undefined) throw new Error("Replay step-specific barrier is unsupported.");
    if (ids.has(step.id) || step.ordinal !== index + 1) throw new Error("Replay step order/identity is invalid.");
    ids.add(step.id);
    if (step.reviewStatus === "needs-review" || step.evidenceGaps?.length) throw new Error(`Replay step ${step.id} needs review.`);
    if (manifest.review.purpose === "regression" && (step.reviewStatus !== "ready" || !step.expected || !Object.keys(step.expected).length || !step.expectedEvidenceRefs?.length))
      throw new Error(`Replay step ${step.id} lacks explicit Expected.`);
    return readRuntimeRegressionSourceInput(step);
  });
  if (procedure.evidenceGaps?.length || procedure.reviewStatus === "needs-review") throw new Error("Replay Procedure has unresolved evidence gaps.");
  return { manifest, procedure: procedure as unknown as SessionProcedure, inputs };
}

export interface RuntimeRegressionAssertion {
  field: string;
  expected: unknown;
  observed?: unknown;
  verdict: "pass" | "fail" | "unevaluated";
}

const OBSERVED_FIELDS = {
  questionType: "questionType", relation: "relation", parentAction: "parentAction", runtimeAction: "runtimeAction",
  contextReadScope: "contextReadScope", artifactIntent: "artifactIntent", playbookPhase: "playbookPhase",
  expectedParentId: "settledParentId", expectedBranchId: "settledBranchId", expectedContextOwnerId: "contextOwnerId",
  expectedProjectId: "projectId", expectedProjectName: "projectName", factAnchorState: "factAnchorState", childContinuity: "childContinuity",
} as const;

export function compareRuntimeRegressionExpected(expected: SessionProcedureExpectedContract | undefined,
  observed: HumanEvaluationObservedSnapshotV2 | undefined, identities: Map<string, string>,
  effects?: { completion: RuntimeRegressionCompletion; requestedArtifacts?: readonly string[]; committedArtifacts?: readonly string[] }): RuntimeRegressionAssertion[] {
  if (!expected) return [];
  return Object.entries(expected).map(([field, value]) => {
    if (field === "terminalDisposition" || field === "requestedArtifacts" || field === "committedArtifacts") {
      const actual = field === "terminalDisposition" ? effects?.completion.disposition : effects?.[field];
      return { field, expected: value, observed: actual, verdict: actual === undefined ? "unevaluated"
        : Array.isArray(value) && Array.isArray(actual) ? JSON.stringify([...value].sort()) === JSON.stringify([...actual].sort()) ? "pass" : "fail"
        : value === actual ? "pass" : "fail" };
    }
    if (!Object.hasOwn(OBSERVED_FIELDS, field)) return { field, expected: value, verdict: "unevaluated" };
    const observedField = OBSERVED_FIELDS[field as keyof typeof OBSERVED_FIELDS];
    const actual = observed?.[observedField];
    if (actual === undefined) return { field, expected: value, verdict: "unevaluated" };
    if (["expectedParentId", "expectedBranchId", "expectedContextOwnerId"].includes(field) && typeof value === "string" && typeof actual === "string") {
      if (!identities.has(value) && ![...identities.values()].includes(actual)) identities.set(value, actual);
      return { field, expected: value, observed: actual, verdict: identities.get(value) === actual ? "pass" : "fail" };
    }
    return { field, expected: value, observed: actual, verdict: value === actual ? "pass" : "fail" };
  });
}
