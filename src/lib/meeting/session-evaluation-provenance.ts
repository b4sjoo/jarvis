export const SESSION_EVALUATION_PROVENANCE_SCHEMA_VERSION = 1 as const;

export interface SessionEvaluationProvenanceRecord {
  schemaVersion: typeof SESSION_EVALUATION_PROVENANCE_SCHEMA_VERSION;
  sessionRecordingId: string;
  effectiveScriptedValidation: boolean;
  updatedAt: number;
  source: "debug-ui" | "reflection-cli";
}

export interface SessionEvaluationProvenanceHistoryEntry
  extends SessionEvaluationProvenanceRecord {
  action: "mark-scripted" | "mark-organic";
}

export function resolveSessionScriptedValidation(input: {
  scriptedValidation?: unknown;
  effectiveScriptedValidation?: unknown;
  legacyEvaluationProvenance?: unknown;
}) {
  if (typeof input.effectiveScriptedValidation === "boolean") {
    return input.effectiveScriptedValidation;
  }
  if (input.scriptedValidation === true) return true;
  return input.legacyEvaluationProvenance === "scripted-validation";
}

export function toHumanEvaluationCollectionProvenance(
  scriptedValidation: boolean
): "scripted-validation" | "organic" {
  return scriptedValidation ? "scripted-validation" : "organic";
}

export function buildSessionEvaluationProvenanceRecord(input: {
  sessionRecordingId: string;
  scriptedValidation: boolean;
  source: SessionEvaluationProvenanceRecord["source"];
  now?: number;
}): SessionEvaluationProvenanceRecord {
  return {
    schemaVersion: SESSION_EVALUATION_PROVENANCE_SCHEMA_VERSION,
    sessionRecordingId: input.sessionRecordingId,
    effectiveScriptedValidation: input.scriptedValidation,
    updatedAt: input.now ?? Date.now(),
    source: input.source,
  };
}

export function buildSessionEvaluationProvenanceHistoryEntry(input: {
  sessionRecordingId: string;
  scriptedValidation: boolean;
  source: SessionEvaluationProvenanceRecord["source"];
  now?: number;
}): SessionEvaluationProvenanceHistoryEntry {
  const record = buildSessionEvaluationProvenanceRecord(input);
  return {
    ...record,
    action: input.scriptedValidation ? "mark-scripted" : "mark-organic",
  };
}
