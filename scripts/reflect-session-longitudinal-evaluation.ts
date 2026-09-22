import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readRecordedTraceSummaries } from "./lib/session-aggregate-evidence.js";
import {
  buildSessionLongitudinalEvaluationReport,
  evaluateLongitudinalSessionEvidenceScope,
  renderSessionLongitudinalEvaluationMarkdown,
  type LongitudinalCriticalMomentCandidate,
  type LongitudinalCriticalMomentEvaluation,
  type LongitudinalQuestionEvaluation,
  type LongitudinalSessionInput,
  type LongitudinalSessionManifest,
  type LongitudinalTraceSummary,
  type LongitudinalTranscriptTurn,
} from "../src/lib/meeting/session-longitudinal-evaluation.js";
import { writeDerivedEvaluationProvenance } from "./lib/derived-evaluation-provenance.js";
import { readRuntimeTraceEvidence, missingAdjudicationEvidenceFiles, type RuntimeTraceEvidence } from "./lib/recorded-trace-evidence.js";
import {
  buildTaskRelationAdjudicationReflectionReport,
  type TaskRelationAdjudicationRecordedDecision,
} from "../src/lib/meeting/task-relation-adjudication-reflection.js";
import { buildTaskRelationAuthorityConvergenceReportV1 } from "../src/lib/meeting/task-relation-authority-convergence.js";
import { buildQuestionTypeAdjudicationOutcomeReport, type QuestionTypeAdjudicationRecordedDecision } from "../src/lib/meeting/question-type-adjudication-outcome.js";
import type { QuestionTypeAdjudicationOutcomeEvent } from "../src/lib/meeting/question-type-adjudication.js";
import { projectMeetingMetadataEvaluationObservation } from "../src/lib/meeting/meeting-metadata-evaluation.js";
import { resolveCommittedSourceTransitionLifecycleEvidence } from "../src/lib/meeting/task-settlement-tuple.js";
import {
  loadSessionHumanEvaluationConsumerView,
  writeHumanEvaluationCompatibilityReport,
} from "./session-human-evaluation-v2.js";

interface CliOptions {
  sessionDirectories: string[];
  outputDirectory?: string;
  allowIncomplete: boolean;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const sessions = await Promise.all(
    options.sessionDirectories.map((directory) =>
      readSession(directory, options.allowIncomplete)
    )
  );
  const report = buildSessionLongitudinalEvaluationReport(sessions);
  const outputDirectory =
    options.outputDirectory ??
    (options.sessionDirectories.length === 1
      ? path.join(
          options.sessionDirectories[0],
          "evaluation",
          "longitudinal"
        )
      : path.join(process.cwd(), "evaluation", "longitudinal"));
  await mkdir(outputDirectory, { recursive: true });
  const jsonPath = path.join(outputDirectory, "report.json");
  const markdownPath = path.join(outputDirectory, "report.md");
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(
      markdownPath,
      renderSessionLongitudinalEvaluationMarkdown(report),
      "utf8"
    ),
  ]);
  await writeDerivedEvaluationProvenance({
    producer: "reflect-session-longitudinal-evaluation",
    command: "session:longitudinal:reflect",
    sessionDirectories: options.sessionDirectories,
    outputDirectory,
    outputPaths: [path.basename(jsonPath), path.basename(markdownPath)],
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        sessions: report.cohort.sessionCount,
        productionTraces: report.cohort.productionTraceCount,
        criticalMoments: report.productOutcomes.criticalMomentCount,
        criticalMomentSuccessRate: report.productOutcomes.cmsr,
        labeledCoverage: report.cohort.labeledTraceCoverage,
        releaseEvidenceEligible: report.evidenceScope.releaseEligible,
        excludedScriptedSessions:
          report.cohort.excludedScriptedSessionCount,
        excludedScriptedTraces:
          report.cohort.excludedScriptedTraceCount,
        jsonPath,
        markdownPath,
      },
      null,
      2
    )}\n`
  );
}

async function readSession(
  directory: string,
  allowIncomplete: boolean
): Promise<LongitudinalSessionInput> {
  const manifestPath = path.join(directory, "manifest.json");
  const transcriptPath = path.join(
    directory,
    "transcripts",
    "turns.jsonl"
  );
  const manifestPresent = await fileExists(manifestPath);
  const manifest = await readOptionalJson<LongitudinalSessionManifest>(
    manifestPath,
    {}
  );
  const evidenceScope = evaluateLongitudinalSessionEvidenceScope({
    manifestPresent,
    transcriptPresent: await fileExists(transcriptPath),
    traceEvidencePresent: await hasTraceEvidence(directory),
    manifest,
  });
  if (!evidenceScope.releaseEligible && !allowIncomplete) {
    throw new Error(
      `Session evidence is incomplete for release evaluation: ${directory} (${evidenceScope.failures.join(", ")}). Re-run with --allow-incomplete only for exploratory non-release output.`
    );
  }
  const [
    transcriptTurns,
    tracePayload,
    criticalMomentCandidatesPayload,
    criticalMomentEvaluationsPayload,
    runtimeTraces,
  ] =
    await Promise.all([
      readJsonLines<LongitudinalTranscriptTurn>(
        transcriptPath
      ),
      readRecordedTraceSummaries<LongitudinalTraceSummary>(directory),
      readOptionalJson<{
        candidates?: LongitudinalCriticalMomentCandidate[];
      }>(
        path.join(
          directory,
          "human-evaluation",
          "critical-moment-candidates.json"
        ),
        { candidates: [] }
      ),
      readOptionalJson<{
        evaluations?: LongitudinalCriticalMomentEvaluation[];
      }>(
        path.join(
          directory,
          "human-evaluation",
          "critical-moment-evaluations.json"
        ),
        { evaluations: [] }
      ),
      readRuntimeTraceEvidence(path.join(directory, "traces")),
    ]);
  for (const warning of tracePayload.warnings) console.warn(`${directory}: ${warning}`);
  const evaluationView =
    await loadSessionHumanEvaluationConsumerView(directory);
  const missingInputs = await missingAdjudicationEvidenceFiles(directory);
  const relationDecisions =
    await readJsonLines<TaskRelationAdjudicationRecordedDecision>(
      path.join(
        directory,
        "runtime-inference",
        "task-relation-decisions.jsonl"
      )
    );
  const taskRelationAdjudicationReport =
    buildTaskRelationAdjudicationReflectionReport({
      decisions: relationDecisions,
      evaluations: evaluationView.legacyEvaluations,
      projections: evaluationView.projections,
      missingInputs,
      settlements: runtimeTraces.map(trace => ({ ...trace, recordedAt: trace.exportedAt ?? 0, sessionId: manifest.sessionId })),
    });
  const questionTypeAdjudicationReport = buildQuestionTypeAdjudicationOutcomeReport({
    missingInputs,
    decisions: await readJsonLines<QuestionTypeAdjudicationRecordedDecision>(path.join(directory, "taxonomy", "question-type-adjudications.jsonl")),
    outcomes: await readJsonLines<QuestionTypeAdjudicationOutcomeEvent>(path.join(directory, "taxonomy", "question-type-adjudication-outcomes.jsonl")),
    settlements: [...relationDecisions, ...runtimeTraces.map(trace => ({ ...trace, recordedAt: trace.exportedAt ?? 0, sessionId: manifest.sessionId }))],
    projections: evaluationView.projections,
  });
  const taskRelationConvergenceReport =
    buildTaskRelationAuthorityConvergenceReportV1({
      relationReport: taskRelationAdjudicationReport,
    });
  await writeHumanEvaluationCompatibilityReport(
    directory,
    evaluationView.report,
    evaluationView.materialization
  );
  const compactByTrace = new Map(
    (tracePayload.traces ?? []).map((trace) => [trace.traceId, trace])
  );
  for (const runtimeTrace of runtimeTraces) {
    compactByTrace.set(
      runtimeTrace.traceId,
      mergeRuntimeTraceEvidence(
        compactByTrace.get(runtimeTrace.traceId),
        runtimeTrace
      )
    );
  }
  return {
    directory,
    manifest,
    transcriptTurns,
    traceSummaries: Array.from(compactByTrace.values()),
    questionEvaluations:
      evaluationView.legacyOnlyEvaluations as LongitudinalQuestionEvaluation[],
    criticalMomentCandidates:
      criticalMomentCandidatesPayload.candidates ?? [],
    criticalMomentEvaluations:
      criticalMomentEvaluationsPayload.evaluations ?? [],
    humanEvaluationProjectionsV2: evaluationView.allProjections,
    taskRelationAdjudicationReport,
    questionTypeAdjudicationReport,
    taskRelationConvergenceReport,
    evidenceScope,
  };
}

function mergeRuntimeTraceEvidence(
  compact: LongitudinalTraceSummary | undefined,
  runtime: RuntimeTraceEvidence
): LongitudinalTraceSummary {
  const metadata = runtime.metadata;
  const perTypeScores = readRecord(metadata.taxonomySemanticPerTypeScores);
  const meetingMetadataObservation =
    projectMeetingMetadataEvaluationObservation(metadata);
  const committedLifecycleEvidence =
    resolveCommittedSourceTransitionLifecycleEvidence({
      runtimeKind: metadata.sourceTransitionRuntimeKind,
      durableAuthorized: metadata.sourceTransitionDurableAuthorized,
      durableMutationApplied: metadata.sourceTransitionDurableMutationApplied,
      parentBeforeId: metadata.sourceTransitionParentBeforeId,
      parentAfterId: metadata.sourceTransitionParentAfterId,
      parentBeforeType: metadata.sourceTransitionParentBeforeType,
      parentAfterType: metadata.sourceTransitionParentAfterType,
      childBeforeId: metadata.sourceTransitionChildBeforeId,
      childAfterId: metadata.sourceTransitionChildAfterId,
    });
  return {
    ...compact,
    traceId: runtime.traceId,
    traceKind: compact?.traceKind ?? runtime.traceKind,
    status: compact?.status ?? runtime.status,
    startedAt: compact?.startedAt ?? runtime.startedAt,
    endedAt:
      compact?.endedAt ??
      (runtime.startedAt !== undefined && runtime.durationMs !== undefined
        ? runtime.startedAt + runtime.durationMs
        : undefined),
    durationMs: compact?.durationMs ?? runtime.durationMs,
    questionType:
      readString(metadata.canonicalQuestionType) ??
      readString(metadata.questionType) ??
      compact?.questionType,
    rawQuestionType:
      readString(metadata.rawQuestionType) ?? compact?.rawQuestionType,
    canonicalQuestionType:
      readString(metadata.canonicalQuestionType) ??
      compact?.canonicalQuestionType,
    taskRelation: readString(metadata.taskRelation) ?? compact?.taskRelation,
    turnGateAction:
      readString(metadata.turnGateAction) ?? compact?.turnGateAction,
    advisorTurnIntent:
      readString(metadata.advisorTurnIntent) ?? compact?.advisorTurnIntent,
    advisorWouldSuppress:
      readBoolean(metadata.advisorWouldSuppress) ??
      compact?.advisorWouldSuppress,
    advisorExecutionAuthorized:
      readBoolean(metadata.advisorExecutionAuthorized) ??
      compact?.advisorExecutionAuthorized,
    taskMutationAuthorized:
      readBoolean(metadata.taskMutationAuthorized) ??
      compact?.taskMutationAuthorized,
    committedLifecycleEvidence:
      committedLifecycleEvidence ?? compact?.committedLifecycleEvidence,
    taskMutationCommand:
      committedLifecycleEvidence?.command ??
      readString(metadata.settledExecutionPlanTaskMutationCommand) ??
      compact?.taskMutationCommand,
    taskLifecycleParentBeforeId:
      readString(
        metadata.taskLifecycleParentBeforeId ??
          metadata.correctionOwnedParentBeforeId ??
          metadata.parentBeforeId
      ) ?? compact?.taskLifecycleParentBeforeId,
    taskLifecycleParentAfterId:
      readString(
        metadata.taskLifecycleParentAfterId ??
          metadata.correctionOwnedParentAfterId ??
          metadata.parentAfterId
      ) ?? compact?.taskLifecycleParentAfterId,
    taskLifecycleParentBeforeType:
      readString(
        metadata.taskLifecycleParentBeforeType ??
          metadata.correctionOwnedParentBeforeType ??
          metadata.parentBeforeType
      ) ?? compact?.taskLifecycleParentBeforeType,
    taskLifecycleParentAfterType:
      readString(
        metadata.taskLifecycleParentAfterType ??
          metadata.correctionOwnedParentAfterType ??
          metadata.parentAfterType
      ) ?? compact?.taskLifecycleParentAfterType,
    advisorOutputDisposition:
      readString(metadata.advisorOutputDisposition) ??
      compact?.advisorOutputDisposition,
    advisorOutputCommittedToUi:
      readBoolean(metadata.advisorOutputCommittedToUi) ??
      compact?.advisorOutputCommittedToUi,
    visibleAnswerChanged:
      readBoolean(metadata.visibleAnswerChanged) ??
      compact?.visibleAnswerChanged,
    manualQuestionTypeCorrectionId:
      readString(metadata.manualQuestionTypeCorrectionId) ??
      compact?.manualQuestionTypeCorrectionId,
    logicalQuestionUnitId:
      readString(metadata.logicalQuestionUnitId) ??
      compact?.logicalQuestionUnitId,
    logicalQuestionCurrentTurnId:
      readString(metadata.logicalQuestionCurrentTurnId) ??
      compact?.logicalQuestionCurrentTurnId,
    logicalQuestionSourceTurnIds:
      readStringArray(metadata.logicalQuestionSourceTurnIds) ??
      compact?.logicalQuestionSourceTurnIds,
    logicalQuestionCompositionReasons:
      readStringArray(metadata.logicalQuestionCompositionReasons) ??
      compact?.logicalQuestionCompositionReasons,
    logicalQuestionTruncated:
      readBoolean(metadata.logicalQuestionTruncated) ??
      compact?.logicalQuestionTruncated,
    advisorPromptIncludedLogicalQuestion:
      readBoolean(metadata.advisorPromptIncludedLogicalQuestion) ??
      compact?.advisorPromptIncludedLogicalQuestion,
    taskBoundary: {
      ...compact?.taskBoundary,
      mutationDisposition:
        readString(metadata.taskBoundaryMutationDisposition) ??
        compact?.taskBoundary?.mutationDisposition,
      authoritySource:
        readString(metadata.taskBoundaryAuthoritySource) ??
        compact?.taskBoundary?.authoritySource,
      sourceTurnIds:
        readStringArray(metadata.taskBoundarySourceTurnIds) ??
        compact?.taskBoundary?.sourceTurnIds,
      parentBeforeId:
        readString(metadata.parentBeforeId) ??
        compact?.taskBoundary?.parentBeforeId,
      parentAfterId:
        readString(metadata.parentAfterId) ??
        compact?.taskBoundary?.parentAfterId,
    },
    semanticTaxonomy: {
      ...compact?.semanticTaxonomy,
      keywordType:
        readString(metadata.taxonomyKeywordType) ??
        compact?.semanticTaxonomy?.keywordType,
      semanticCandidateType:
        readString(metadata.taxonomySemanticCandidateType) ??
        compact?.semanticTaxonomy?.semanticCandidateType,
      semanticTopCandidateType:
        readSemanticTopCandidateType(perTypeScores) ??
        compact?.semanticTaxonomy?.semanticTopCandidateType,
      hybridOutcome:
        readString(metadata.taxonomyHybridOutcome) ??
        compact?.semanticTaxonomy?.hybridOutcome,
      hybridEffectiveType:
        readString(metadata.taxonomyHybridEffectiveType) ??
        compact?.semanticTaxonomy?.hybridEffectiveType,
      rescueApplied:
        readBoolean(metadata.taxonomySemanticRescueApplied) ??
        compact?.semanticTaxonomy?.rescueApplied,
      durationMs:
        readNumber(metadata.taxonomySemanticDurationMs) ??
        compact?.semanticTaxonomy?.durationMs,
    },
    taxonomyAdjudication: {
      ...compact?.taxonomyAdjudication,
      candidateType:
        readString(metadata.taxonomyAdjudicationCandidateType) ??
        compact?.taxonomyAdjudication?.candidateType,
      relation:
        readString(metadata.taxonomyAdjudicationRelation) ??
        compact?.taxonomyAdjudication?.relation,
      providerConfigurationStatus:
        readString(metadata.taxonomyAdjudicationProviderConfigurationStatus) ??
        compact?.taxonomyAdjudication?.providerConfigurationStatus,
      providerDisposition:
        readString(metadata.taxonomyAdjudicationProviderDisposition) ??
        compact?.taxonomyAdjudication?.providerDisposition,
      parseValid:
        readBoolean(metadata.taxonomyAdjudicationParseValid) ??
        compact?.taxonomyAdjudication?.parseValid,
      durationMs:
        readNumber(metadata.taxonomyAdjudicationDurationMs) ??
        compact?.taxonomyAdjudication?.durationMs,
    },
    meetingMetadata: {
      ...compact?.meetingMetadata,
      revision:
        readNumber(metadata.meetingMetadataInferenceRevision) ??
        compact?.meetingMetadata?.revision,
      operationId:
        readString(metadata.meetingMetadataInferenceOperationId) ??
        compact?.meetingMetadata?.operationId,
      mode:
        readString(metadata.meetingMetadataInferenceMode) ??
        compact?.meetingMetadata?.mode,
      disposition:
        readString(metadata.meetingMetadataInferenceDisposition) ??
        compact?.meetingMetadata?.disposition,
      proposalCompany:
        readString(metadata.meetingMetadataInferenceProposalCompany) ??
        compact?.meetingMetadata?.proposalCompany,
      committedCompany:
        readString(metadata.meetingMetadataInferenceCommittedCompany) ??
        compact?.meetingMetadata?.committedCompany,
      authoritativeCompany:
        readString(metadata.meetingMetadataInferenceAuthoritativeCompany) ??
        compact?.meetingMetadata?.authoritativeCompany,
      effectiveCompany:
        readString(metadata.meetingMetadataInferenceCommittedCompany) ??
        readString(metadata.meetingMetadataInferenceAuthoritativeCompany) ??
        readString(metadata.targetCompany) ??
        compact?.meetingMetadata?.effectiveCompany,
      authoritySource:
        readString(metadata.meetingMetadataInferenceCommittedSource) ??
        readString(metadata.meetingMetadataInferenceAuthoritativeSource) ??
        compact?.meetingMetadata?.authoritySource,
      comparisonDisposition:
        readString(metadata.meetingMetadataInferenceComparisonDisposition) ??
        compact?.meetingMetadata?.comparisonDisposition,
      staleReason:
        readString(metadata.meetingMetadataInferenceStaleReason) ??
        compact?.meetingMetadata?.staleReason,
      appliedToRuntime:
        readBoolean(metadata.meetingMetadataInferenceAppliedToRuntime) ??
        compact?.meetingMetadata?.appliedToRuntime,
      overrideOccurred:
        compact?.meetingMetadata?.overrideOccurred ??
        meetingMetadataObservation.overrideOccurred,
    },
  };
}

function readSemanticTopCandidateType(
  perTypeScores: Record<string, unknown> | undefined
) {
  if (!perTypeScores) return undefined;
  let bestType: string | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const [type, rawScore] of Object.entries(perTypeScores)) {
    const candidate = readRecord(rawScore);
    const score = readNumber(candidate?.positiveScore);
    if (score === undefined || score <= bestScore) continue;
    bestScore = score;
    bestType = readString(candidate?.questionType) ?? type;
  }
  return bestType;
}

function readRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

function parseOptions(args: string[]): CliOptions {
  const sessionDirectories: string[] = [];
  let outputDirectory: string | undefined;
  let allowIncomplete = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--session" && args[index + 1]) {
      sessionDirectories.push(path.resolve(args[index + 1]));
      index += 1;
      continue;
    }
    if (args[index] === "--output" && args[index + 1]) {
      outputDirectory = path.resolve(args[index + 1]);
      index += 1;
      continue;
    }
    if (args[index] === "--allow-incomplete") {
      allowIncomplete = true;
    }
  }
  if (!sessionDirectories.length) {
    throw new Error(
      "Usage: npm run session:longitudinal:reflect -- --session <recording-folder> [--session <folder>] [--output <folder>] [--allow-incomplete]"
    );
  }
  return { sessionDirectories, outputDirectory, allowIncomplete };
}

async function hasTraceEvidence(directory: string) {
  if (
    await fileExists(
      path.join(directory, "metrics", "trace-summaries.latest.json")
    )
  ) {
    return true;
  }
  try {
    const entries = await readdir(path.join(directory, "traces"), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) return true;
      if (entry.isDirectory() && await fileExists(path.join(directory, "traces", entry.name, "summary.json"))) return true;
    }
    return false;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function readJsonLines<T>(filePath: string) {
  try {
    return (await readFile(filePath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

async function readOptionalJson<T>(filePath: string, fallback: T) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (isMissingFile(error)) return fallback;
    throw error;
  }
}

function isMissingFile(error: unknown) {
  return (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
