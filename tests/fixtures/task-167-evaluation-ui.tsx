import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
// The browser test exposes this private component at build time, unchanged.
import { TraceHumanEvaluationPanel, AttemptEvaluationFixture } from "../../src/pages/app/components/meeting";
import { ManualAdviseDisplay } from "../../src/lib/meeting/manual-advise-display";
import { buildMeetingAnswerDisplayModel } from "../../src/lib/meeting/meeting-answer-display";
import { buildHumanEvaluationAttemptEvidenceV2 } from "../../src/lib/meeting/human-evaluation-attempt-projection";
import { createHumanGroundTruthEventV2, deriveHumanEvaluationProjectionV2, findActiveHumanGroundTruthEventV2 } from "../../src/lib/meeting/human-ground-truth-v2";
import { hnswTrace, hnswHumanFacts } from "./task-167-evaluation-ui-hnsw";

const fixture = (window as any).__evaluation = {
  calls: [] as any[], events: [] as any[], legacyCalls: [] as any[], preparationCalls: [] as any[], retries: 0,
};
const trace = {
  id: "attempt-167", kind: "voice", status: "success", startedAt: 1,
  inputs: [], outputs: [], steps: [],
  metadata: {
    questionTypeAdjudicationCandidateType: "coding",
    questionTypeAdjudicationDisposition: "abstained",
    questionTypeAdjudicationWouldRepair: true,
    currentQuestionSettlementId: "settlement-167",
    effectiveCurrentQuestionSettlementMaterialized: true,
    effectiveCurrentQuestionSettlementId: "settlement-167",
    effectiveCurrentQuestionSettlementQuestionType: "project-deep-dive",
    effectiveCurrentQuestionSettlementRelation: "followup-parent",
    effectiveCurrentQuestionSettlementParentMutationAuthorized: false,
    effectiveCurrentQuestionSettlementParentId: "parent-167",
    effectiveCurrentQuestionContextReadScope: "active-parent-read",
    currentQuestionSettlementType: "project-deep-dive",
    currentQuestionSettlementRelation: "followup-parent",
    currentQuestionSettlementDisposition: "committed",
    settledExecutionPlanTaskMutationCommand: "preserve",
    settledExecutionPlanExpectedParentId: "parent-167",
    settledExecutionPlanPostMutationParentId: "parent-167",
    primaryAskNormalizedText: "Explain the original project.",
    meetingMetadataInferenceCommittedCompany: "Google",
    meetingMetadataInferenceCommittedSource: "runtime-inference",
    meetingMetadataInferenceAuthoritativeCompany: "Amazon",
    meetingMetadataInferenceAppliedToRuntime: true,
    // Every retired specialist flag is deliberately present.
    clarifyingQuestionPresent: true, clarifyingOptionCount: 3,
    transientPersonalStatusApplied: true, transientPersonalStatusDomain: "relocation",
    primaryAskDisposition: "accepted", answerSufficiencyStatus: "insufficient",
    answerRepairRecommendation: "clarify", contextResolvable: true,
    whiteboardRenderStatus: "failed", whiteboardRenderValidationDisposition: "invalid",
    whiteboardRepairDisposition: "failed", whiteboardRenderFallbackKind: "source",
    currentQuestionSettlementParentMutationAuthorized: false,
  },
} as any;

function Fixture() {
  const [version, refresh] = useState(0);
  const [persistence, setPersistence] = useState({ pending: 0, error: null as string | null });
  const [currentTrace, setTrace] = useState(trace);
  const sessionId = currentTrace.metadata.effectiveCurrentQuestionSettlementSessionId ?? "session-167";
  const subject = { attemptId: currentTrace.id, traceIds: [currentTrace.id], sourceTurnIds: ["turn-167"] };
  const observed = buildHumanEvaluationAttemptEvidenceV2({ trace: currentTrace, traces: [currentTrace] }).observed;
  const projection = deriveHumanEvaluationProjectionV2({ sessionId, subject, events: fixture.events, observed });
  fixture.projection = projection;
  fixture.persistence = setPersistence;
  fixture.rerender = () => refresh((v) => v + 1);
  fixture.newAttempt = () => setTrace({ ...trace, id: "attempt-168" });
  fixture.hnsw = hnswTrace;
  fixture.loadTrace = (next: any) => { fixture.events = []; fixture.calls = []; setTrace(next); };
  fixture.updateTrace = (metadata: any, status = "success") => setTrace((previous: any) => ({ ...previous, status, metadata }));
  fixture.loadHnswFacts = () => { fixture.events = structuredClone(hnswHumanFacts); refresh((v) => v + 1); };
  fixture.reset = () => { fixture.events = []; fixture.calls = []; setTrace(trace); refresh((v) => v + 1); };
  fixture.commit = () => {
    fixture.events = [];
    for (const [index, { fact, options, subject: frozenSubject, sessionId: frozenSessionId }] of fixture.calls.entries()) {
      const previous = findActiveHumanGroundTruthEventV2(fixture.events, frozenSubject, fact.kind);
      fixture.events.push(createHumanGroundTruthEventV2({
        sessionId: frozenSessionId, subject: frozenSubject, fact, source: "explicit-ui", confirmation: "confirmed",
        interaction: options.interaction, supersedesEventId: previous?.eventId,
        eventId: `fixture-event-${index}`, now: index + 1,
      }));
    }
    refresh((v) => v + 1);
  };
  return <main data-version={version} style={{ maxWidth: 520, margin: "0 auto", padding: 12 }}>
    <TraceHumanEvaluationPanel
      key={currentTrace.id}
      trace={currentTrace} traces={[currentTrace]} detectedQuestionType={currentTrace.metadata.effectiveCurrentQuestionSettlementQuestionType}
      detectedPlaybook={currentTrace.metadata.settledExecutionPlanPlaybookId ?? "project_deep_dive"}
      taxonomyAdjudicationCandidateType={currentTrace.metadata.questionTypeAdjudicationCandidateType}
      taxonomyAdjudicationDisposition={currentTrace.metadata.questionTypeAdjudicationDisposition}
      taxonomyAdjudicationWouldRepair={currentTrace.metadata.questionTypeAdjudicationWouldRepair}
      projectionV2={projection}
      memorySnapshot={{ status: "available", snapshot: { entries: [
        { id: "memory-167", title: "Project reliability", score: 1, matchReason: ["project"] },
        { id: "memory-168", title: "Other project", score: 0.5, matchReason: [] },
      ] } }}
      preparationArtifactUses={[{ receiptId: "receipt-167", artifactId: "prep-167", artifactPath: "preparation/notes", consumer: "advisor", snapshotVersion: 1, answerRevision: 2 }]}
      preparationArtifactEvaluations={[{ receiptId: "receipt-167", label: "polluting" }]}
      onUpdatePreparationArtifactEvaluation={(receiptId: string, label: string) => fixture.preparationCalls.push({ receiptId, label })}
      evaluationPersistence={persistence}
      onRetrySave={() => { fixture.retries++; }}
      onRecordGroundTruthV2={(fact: any, options: any) => { fixture.calls.push({ fact, options, subject, sessionId }); }}
      {...{ onUpdate: (...args: any[]) => fixture.legacyCalls.push(args), onUpdateQuestion: (...args: any[]) => fixture.legacyCalls.push(args) }}
    />
  </main>;
}
function AttemptFixture() {
  const [session, setSession] = useState(1);
  const [frame, setFrame] = useState(() => makeFrame("A", 1));
  const [, refresh] = useState(0);
  const [display] = useState(() => new ManualAdviseDisplay());
  const [calls] = useState<any[]>([]);
  const [saved] = useState<any[]>([]);
  const current = {
    target: { sessionId: `session-${session}`, suggestionId: frame.suggestion.id,
      traceId: frame.suggestion.sourceTraceId, generationId: frame.suggestion.id, stableRevision: frame.revision },
    stable: { suggestion: frame.suggestion }, streaming: false,
    sections: buildMeetingAnswerDisplayModel({ content: frame.suggestion.content }),
  } as any;
  const selected = display.select(current, current);
  const meeting = {
    settings: { debugMode: true }, meetingSessionId: `session-${session}`,
    status: frame.traces[0].status === "running" ? "thinking" : "listening",
    partialSuggestion: "", latestSuggestion: frame.suggestion, traces: frame.traces,
    questionEvaluations: [], humanEvaluationProjectionsV2: [], preparationArtifactUses: [], preparationArtifactEvaluations: [],
    evaluationPersistence: { pending: calls.length - saved.length, error: null },
    loadHumanEvaluationSession: async () => {}, updatePreparationArtifactEvaluation() {}, retryHumanEvaluationSave() {},
    recordHumanGroundTruthV2(traceId: string, fact: unknown, options: unknown) {
      calls.push(structuredClone({ traceId, fact, options }));
      refresh(v => v + 1);
    },
  };
  (window as any).__attempt = {
    calls, saved,
    publish(id: string, status = "success", hasAnswer = true) {
      setFrame(previous => {
        const next = makeFrame(id, session, status);
        return { ...next, revision: previous.revision + 1,
          suggestion: hasAnswer ? next.suggestion : previous.suggestion,
          traces: [next.traces[0], ...previous.traces.filter(item => item.id !== next.traces[0].id)] };
      });
    },
    pin() { display.toggle(); refresh(v => v + 1); },
    unlock() { display.toggle(); refresh(v => v + 1); },
    finishSave(index: number) { saved.push(structuredClone(calls[index])); refresh(v => v + 1); },
    reset() {
      calls.length = 0; saved.length = 0; display.clear();
      setSession(session + 1); setFrame(makeFrame("A", session + 1));
    },
  };
  return <main style={{ maxWidth: 520, margin: "0 auto", padding: 12 }}>
    <AttemptEvaluationFixture meeting={meeting} adviseDisplay={{ ...selected, locked: display.locked }} />
  </main>;
}

function makeFrame(id: string, session: number, status = "success") {
  const currentTrace = { ...trace, id: `attempt-${id}`, status, metadata: { ...trace.metadata,
    primaryAskNormalizedText: `Question ${id}`,
    effectiveCurrentQuestionSettlementSessionId: `session-${session}`,
    effectiveCurrentQuestionSettlementUnitId: `unit-${id}`,
    effectiveCurrentQuestionSettlementSourceHash: `source-${id}`,
    effectiveCurrentQuestionSettlementId: `settlement-${id}`,
  } };
  return { traces: [currentTrace], revision: 1, suggestion: { id: `answer-${id}`,
    sourceTraceId: currentTrace.id, content: `Answer: Response ${id}`, kind: "answer",
    createdAt: 1, basedOnTurnIds: [], basedOnObservationIds: [], confidence: "medium" } };
}

function RootFixture() {
  const [attemptWrapper, setAttemptWrapper] = useState(false);
  fixture.showAttemptWrapper = () => setAttemptWrapper(true);
  return attemptWrapper ? <AttemptFixture /> : <Fixture />;
}
createRoot(document.getElementById("root")!).render(<StrictMode><RootFixture /></StrictMode>);
