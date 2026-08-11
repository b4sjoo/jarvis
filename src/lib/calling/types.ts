export type CallSessionState =
  | "planned"
  | "starting"
  | "live"
  | "paused"
  | "recovering"
  | "closing"
  | "closed"
  | "start-failed"
  | "close-failed"
  | "abandoned";

export type CallTurnDisposition = "actionable" | "context-only" | "incomplete";

export type CounterpartyMove =
  | "question"
  | "request"
  | "refusal"
  | "condition"
  | "commitment"
  | "correction"
  | "informational"
  | "unknown";

export type PhaseSignal = "advance" | "hold" | "revisit" | "close" | "none";

export type CaseUpdateKind =
  | "claim"
  | "commitment"
  | "deadline"
  | "reference-number"
  | "action";

export interface PendingCaseUpdateProposal {
  id: string;
  kind: CaseUpdateKind;
  value: string;
  sourceMomentUnitId: string;
}

export interface CallTurnSettlement {
  callSessionId: string;
  momentUnitId: string;
  evidenceRevision: number;
  disposition: CallTurnDisposition;
  counterpartyMove: CounterpartyMove;
  phaseSignal: PhaseSignal;
  candidateUpdates: PendingCaseUpdateProposal[];
  responseAuthorized: boolean;
  settledAt: number;
}

export interface GuidanceFrame {
  say: string[];
  ask: string[];
  avoid: string[];
  evidence: string[];
  callState: string;
  nextMove: string;
}

export interface CallTranscriptTurn {
  id: string;
  speaker: "me" | "them";
  text: string;
  occurredAt: number;
}

export type GuidanceEvaluationLabel = "helpful" | "not-useful";

export interface GuidanceEvaluationFact {
  id: string;
  callSessionId: string;
  guidanceRevision: number;
  label: GuidanceEvaluationLabel;
  occurredAt: number;
}

export type PreparedArtifactTarget = "stt" | "runtime" | "advisor" | "post-call";

export type PreparedArtifactReceiptStatus =
  | "selected"
  | "dispatched"
  | "provider-returned"
  | "commit-authorized"
  | "visible"
  | "rejected"
  | "stale"
  | "failed"
  | "cancelled";

export interface PreparedArtifactDescriptor {
  artifactId: string;
  section: string;
  contentHash: string;
  sourceRefs: Array<{
    sourceKind: string;
    sourceId: string;
    contentHash: string;
  }>;
}

export interface PreparedPlaybookStage {
  id: "orient" | "establish" | "request" | "resolve" | "confirm-close";
  goal: string;
  prompts: string[];
  exitSignals: string[];
}

export type RuntimePreparationContext =
  | {
      mode: "neutral";
      callSessionId: string;
      boundAt: number;
    }
  | {
      mode: "prepared";
      callSessionId: string;
      boundAt: number;
      caseId: string;
      caseRevisionId: string;
      callPlanId: string;
      snapshotId: string;
      snapshotContentHash: string;
      artifacts: PreparedArtifactDescriptor[];
      artifactIdsByTarget: Record<PreparedArtifactTarget, string[]>;
      stt: {
        speechBiasTerms: string[];
      };
      runtime: {
        objective: string;
        acceptableOutcomes: string[];
        questionsToAsk: string[];
        knownRisks: string[];
        stages: PreparedPlaybookStage[];
        fallbackMoves: string[];
      };
      advisor: {
        callBrief: unknown;
        caseSnapshot: unknown;
        playbook: unknown;
        evidenceIndex: unknown;
        safetyConstraints: unknown;
      };
      postCall: {
        callBrief: unknown;
        caseSnapshot: unknown;
        evidenceIndex: unknown;
        safetyConstraints: unknown;
      };
    };
