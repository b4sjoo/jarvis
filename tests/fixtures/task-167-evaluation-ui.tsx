import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
// The browser test exposes this private component at build time, unchanged.
import { TraceHumanEvaluationPanel } from "../../src/pages/app/components/meeting";
import { buildHumanEvaluationAttemptEvidenceV2 } from "../../src/lib/meeting/human-evaluation-attempt-projection";
import { createHumanGroundTruthEventV2, deriveHumanEvaluationProjectionV2, findActiveHumanGroundTruthEventV2 } from "../../src/lib/meeting/human-ground-truth-v2";

const fixture = (window as any).__evaluation = {
  calls: [] as any[], events: [] as any[], legacyCalls: [] as any[], preparationCalls: [] as any[], retries: 0,
};
const trace = {
  id: "attempt-167", kind: "voice", status: "success", startedAt: 1,
  inputs: [], outputs: [], steps: [],
  metadata: {
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
  const subject = { attemptId: currentTrace.id, traceIds: [currentTrace.id], sourceTurnIds: ["turn-167"] };
  const observed = buildHumanEvaluationAttemptEvidenceV2({ trace: currentTrace, traces: [currentTrace] }).observed;
  const projection = deriveHumanEvaluationProjectionV2({ sessionId: "session-167", subject, events: fixture.events, observed });
  fixture.projection = projection;
  fixture.persistence = setPersistence;
  fixture.rerender = () => refresh((v) => v + 1);
  fixture.newAttempt = () => setTrace({ ...trace, id: "attempt-168" });
  fixture.reset = () => { fixture.events = []; fixture.calls = []; setTrace(trace); refresh((v) => v + 1); };
  fixture.commit = () => {
    fixture.events = [];
    for (const [index, { fact, options, subject: frozenSubject }] of fixture.calls.entries()) {
      const previous = findActiveHumanGroundTruthEventV2(fixture.events, frozenSubject, fact.kind);
      fixture.events.push(createHumanGroundTruthEventV2({
        sessionId: "session-167", subject: frozenSubject, fact, source: "explicit-ui", confirmation: "confirmed",
        interaction: options.interaction, supersedesEventId: previous?.eventId,
        eventId: `fixture-event-${index}`, now: index + 1,
      }));
    }
    refresh((v) => v + 1);
  };
  return <main data-version={version} style={{ maxWidth: 520, margin: "0 auto", padding: 12 }}>
    <TraceHumanEvaluationPanel
      key={currentTrace.id}
      trace={currentTrace} traces={[currentTrace]} detectedQuestionType="project-deep-dive"
      detectedPlaybook="project_deep_dive" taxonomyAdjudicationCandidateType="coding"
      taxonomyAdjudicationDisposition="abstained" taxonomyAdjudicationWouldRepair={true}
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
      onRecordGroundTruthV2={(fact: any, options: any) => { fixture.calls.push({ fact, options, subject }); }}
      {...{ onUpdate: (...args: any[]) => fixture.legacyCalls.push(args), onUpdateQuestion: (...args: any[]) => fixture.legacyCalls.push(args) }}
    />
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
