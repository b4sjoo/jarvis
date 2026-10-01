export const SESSION_EVALUATION_PROVENANCE_SCHEMA_VERSION = 1 as const;

export interface SessionEvaluationProvenanceRecord {
  schemaVersion: typeof SESSION_EVALUATION_PROVENANCE_SCHEMA_VERSION;
  sessionRecordingId: string;
  effectiveScriptedValidation: boolean;
  forced?: true;
  scenarioRunId?: string;
  updatedAt: number;
  source: "debug-ui" | "reflection-cli" | "scenario-runner";
}

export interface SessionEvaluationProvenanceHistoryEntry
  extends SessionEvaluationProvenanceRecord {
  action: "mark-scripted" | "mark-organic";
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
  forced?: boolean;
  scenarioRunId?: string;
  now?: number;
}): SessionEvaluationProvenanceRecord {
  return {
    schemaVersion: SESSION_EVALUATION_PROVENANCE_SCHEMA_VERSION,
    sessionRecordingId: input.sessionRecordingId,
    effectiveScriptedValidation: input.scriptedValidation,
    ...(input.forced ? { forced: true as const } : {}),
    ...(input.scenarioRunId
      ? { scenarioRunId: input.scenarioRunId }
      : {}),
    updatedAt: input.now ?? Date.now(),
    source: input.source,
  };
}

export function buildSessionEvaluationProvenanceHistoryEntry(input: {
  sessionRecordingId: string;
  scriptedValidation: boolean;
  source: SessionEvaluationProvenanceRecord["source"];
  forced?: boolean;
  scenarioRunId?: string;
  now?: number;
}): SessionEvaluationProvenanceHistoryEntry {
  const record = buildSessionEvaluationProvenanceRecord(input);
  return {
    ...record,
    action: input.scriptedValidation ? "mark-scripted" : "mark-organic",
  };
}
