interface RefreshAuthorityShape {
  authorized: boolean;
  kind: string;
  reason: string;
  hardOverride: boolean;
  maySupersedeGeneration: boolean;
  authorityId?: string;
}

type ResponseOpportunityRefreshAuthority =
  | {
      authorized: true;
      kind: "runtime-intent-answer";
      reason:
        | "response-opportunity-pending"
        | "response-opportunity-output-authorized";
      hardOverride: false;
      maySupersedeGeneration: true;
    }
  | {
      authorized: false;
      kind: "denied";
      reason: "response-opportunity-preserve-stable-answer";
      hardOverride: false;
      maySupersedeGeneration: false;
    };

export interface ResponseOpportunityGenerationGateLease {
  operationId: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  sourceHash: string;
  manualCorrectionRevision: number;
  createdAt: number;
}

export type ResponseOpportunityGenerationDisposition =
  | "pending"
  | "output-authorized"
  | "output-suppressed"
  | "unresolved"
  | "stale";

export type ResponseOpportunityEffectiveCommand =
  | "output-authorized"
  | "preserve-stable-answer";

export const RESPONSE_OPPORTUNITY_GENERATION_WAIT_MS = 2_200;

export interface ResponseOpportunityGenerationGateSnapshot {
  operationId: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  sourceHash: string;
  manualCorrectionRevision: number;
  disposition: ResponseOpportunityGenerationDisposition;
  reason: string;
  createdAt: number;
  settledAt?: number;
}

interface GateRecord {
  snapshot: ResponseOpportunityGenerationGateSnapshot;
  waiters: Array<
    (snapshot: ResponseOpportunityGenerationGateSnapshot) => void
  >;
}

export class ResponseOpportunityGenerationGateCoordinator {
  private readonly records = new Map<string, GateRecord>();

  create(
    lease: ResponseOpportunityGenerationGateLease
  ): ResponseOpportunityGenerationGateSnapshot {
    const existing = this.records.get(lease.operationId);
    if (existing) return cloneSnapshot(existing.snapshot);
    const snapshot: ResponseOpportunityGenerationGateSnapshot = {
      operationId: lease.operationId,
      sessionId: lease.sessionId,
      runtimeEpoch: lease.runtimeEpoch,
      logicalQuestionUnitId: lease.logicalQuestionUnitId,
      logicalQuestionUnitRevision:
        lease.logicalQuestionUnitRevision,
      sourceHash: lease.sourceHash,
      manualCorrectionRevision: lease.manualCorrectionRevision,
      disposition: "pending",
      reason: "runtime-response-opportunity-pending",
      createdAt: lease.createdAt,
    };
    this.records.set(lease.operationId, { snapshot, waiters: [] });
    this.trim();
    return cloneSnapshot(snapshot);
  }

  findOperationId(input: {
    logicalQuestionUnitId: string;
    logicalQuestionUnitRevision: number;
  }): string | undefined {
    const matches = Array.from(this.records.values())
      .map((record) => record.snapshot)
      .filter(
        (snapshot) =>
          snapshot.logicalQuestionUnitId ===
            input.logicalQuestionUnitId &&
          snapshot.logicalQuestionUnitRevision ===
            input.logicalQuestionUnitRevision &&
          snapshot.disposition !== "stale"
      )
      .sort((left, right) => right.createdAt - left.createdAt);
    return matches[0]?.operationId;
  }

  read(
    operationId: string | undefined
  ): ResponseOpportunityGenerationGateSnapshot | undefined {
    if (!operationId) return undefined;
    const record = this.records.get(operationId);
    return record ? cloneSnapshot(record.snapshot) : undefined;
  }

  settle(input: {
    operationId: string;
    disposition: Exclude<
      ResponseOpportunityGenerationDisposition,
      "pending"
    >;
    reason: string;
    settledAt?: number;
  }): ResponseOpportunityGenerationGateSnapshot | undefined {
    const record = this.records.get(input.operationId);
    if (!record || record.snapshot.disposition !== "pending") {
      return record ? cloneSnapshot(record.snapshot) : undefined;
    }
    record.snapshot = {
      ...record.snapshot,
      disposition: input.disposition,
      reason: input.reason,
      settledAt: input.settledAt ?? Date.now(),
    };
    const snapshot = cloneSnapshot(record.snapshot);
    for (const resolve of record.waiters.splice(0)) {
      resolve(snapshot);
    }
    this.trim();
    return snapshot;
  }

  async wait(
    operationId: string,
    timeoutMs: number
  ): Promise<ResponseOpportunityGenerationGateSnapshot> {
    const record = this.records.get(operationId);
    if (!record) {
      return missingGateSnapshot(operationId);
    }
    if (record.snapshot.disposition !== "pending") {
      return cloneSnapshot(record.snapshot);
    }
    return new Promise((resolve) => {
      let settled = false;
      const complete = (
        snapshot: ResponseOpportunityGenerationGateSnapshot
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(cloneSnapshot(snapshot));
      };
      const timeout = setTimeout(() => {
        const timedOut = this.settle({
          operationId,
          disposition: "output-authorized",
          reason: "response-null-hypothesis:gate-wait-timeout",
        });
        complete(timedOut ?? missingGateSnapshot(operationId));
      }, Math.max(0, timeoutMs));
      record.waiters.push(complete);
    });
  }

  cancelAll(reason: string) {
    for (const record of this.records.values()) {
      if (record.snapshot.disposition !== "pending") continue;
      this.settle({
        operationId: record.snapshot.operationId,
        disposition: "stale",
        reason,
      });
    }
  }

  private trim() {
    while (this.records.size > 32) {
      const oldest = this.records.keys().next().value;
      if (!oldest) break;
      const record = this.records.get(oldest);
      if (record?.snapshot.disposition === "pending") break;
      this.records.delete(oldest);
    }
  }
}

export function formatResponseOpportunityGenerationGateForTrace(
  snapshot: ResponseOpportunityGenerationGateSnapshot | undefined
) {
  const effectiveCommand =
    resolveResponseOpportunityEffectiveCommand(snapshot);
  return {
    responseOpportunityGenerationGateOperationId:
      snapshot?.operationId,
    responseOpportunityGenerationGateDisposition:
      snapshot?.disposition,
    responseOpportunityGenerationGateReason: snapshot?.reason,
    responseOpportunityGenerationGateCreatedAt: snapshot?.createdAt,
    responseOpportunityGenerationGateSettledAt: snapshot?.settledAt,
    responseOpportunityTransientDisposition: snapshot?.disposition,
    responseOpportunityEffectiveCommand: effectiveCommand,
    responseOpportunityEffectiveAuthoritySource:
      effectiveCommand === "output-authorized"
        ? "response-opportunity"
        : effectiveCommand === "preserve-stable-answer"
          ? "response-opportunity-no-output"
          : undefined,
  };
}

export function resolveResponseOpportunityEffectiveCommand(
  snapshot: ResponseOpportunityGenerationGateSnapshot | undefined
): ResponseOpportunityEffectiveCommand | undefined {
  if (!snapshot || snapshot.disposition === "pending") return undefined;
  return snapshot.disposition === "output-authorized"
    ? "output-authorized"
    : "preserve-stable-answer";
}

export function shouldRetainImmediateTaskCommand(input: {
  immediateCandidate: boolean;
  mutationSuppressedByScope: boolean;
  responseOpportunityOperationId?: string;
  responseOpportunityGate?: ResponseOpportunityGenerationGateSnapshot;
}) {
  if (!input.immediateCandidate || input.mutationSuppressedByScope) {
    return false;
  }
  if (!input.responseOpportunityOperationId) return true;
  return (
    !input.responseOpportunityGate ||
    input.responseOpportunityGate.disposition === "pending" ||
    input.responseOpportunityGate.disposition === "output-authorized"
  );
}

export function responseOpportunityAuthorizesImmediateTaskCommand(input: {
  immediateCandidate: boolean;
  mutationSuppressedByScope: boolean;
  responseOpportunityOperationId?: string;
  responseOpportunityGate?: ResponseOpportunityGenerationGateSnapshot;
}) {
  if (!input.immediateCandidate || input.mutationSuppressedByScope) {
    return false;
  }
  if (!input.responseOpportunityOperationId) return true;
  return (
    resolveResponseOpportunityEffectiveCommand(
      input.responseOpportunityGate
    ) === "output-authorized"
  );
}

export function resolveResponseOpportunityRefreshAuthority<
  TAuthority extends RefreshAuthorityShape,
>(input: {
  localAuthority: TAuthority;
  operationId?: string;
  snapshot?: ResponseOpportunityGenerationGateSnapshot;
}): TAuthority | ResponseOpportunityRefreshAuthority {
  if (!input.operationId) return input.localAuthority;
  if (input.localAuthority.hardOverride) return input.localAuthority;

  const command = resolveResponseOpportunityEffectiveCommand(input.snapshot);
  if (command === "preserve-stable-answer") {
    return {
      authorized: false,
      kind: "denied",
      reason: "response-opportunity-preserve-stable-answer",
      hardOverride: false,
      maySupersedeGeneration: false,
    };
  }

  return {
    authorized: true,
    kind: "runtime-intent-answer",
    reason: command
      ? "response-opportunity-output-authorized"
      : "response-opportunity-pending",
    hardOverride: false,
    maySupersedeGeneration: true,
  };
}

function cloneSnapshot(
  snapshot: ResponseOpportunityGenerationGateSnapshot
): ResponseOpportunityGenerationGateSnapshot {
  return { ...snapshot };
}

function missingGateSnapshot(
  operationId: string
): ResponseOpportunityGenerationGateSnapshot {
  return {
    operationId,
    sessionId: "",
    runtimeEpoch: -1,
    logicalQuestionUnitId: "",
    logicalQuestionUnitRevision: -1,
    sourceHash: "",
    manualCorrectionRevision: -1,
    disposition: "unresolved",
    reason: "generation-gate-missing",
    createdAt: Date.now(),
    settledAt: Date.now(),
  };
}
