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
