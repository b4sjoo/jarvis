export type AudioSegmentDisposition =
  | "accepted"
  | "prompt-echo-retry-accepted"
  | "prompt-echo-retry-rejected"
  | "stt-error"
  | "stale"
  | "duplicate"
  | "invalid-sequence";

export interface AudioSegmentIdentity {
  captureSessionId: string;
  captureGeneration: number;
  segmentSequence: number;
}

export interface AudioSegmentObservation {
  key: string;
  identity: AudioSegmentIdentity;
  traceId?: string;
  observationDisposition: "first-observation" | "duplicate-observation";
  observationCount: number;
  duplicateObservationCount: number;
  canonicalDisposition?: AudioSegmentDisposition;
  canonicalSettledAt?: number;
}

export interface AudioSegmentSettlement {
  key: string;
  identity: AudioSegmentIdentity;
  traceId?: string;
  proposedDisposition: AudioSegmentDisposition;
  canonicalDisposition: AudioSegmentDisposition;
  canonicalCommitted: boolean;
  observationCount: number;
  duplicateObservationCount: number;
  canonicalSettledAt: number;
  reason?: string;
}

interface AudioSegmentLedgerEntry {
  identity: AudioSegmentIdentity;
  traceId?: string;
  observationCount: number;
  duplicateObservationCount: number;
  firstObservedAt: number;
  lastObservedAt: number;
  canonicalDisposition?: AudioSegmentDisposition;
  canonicalSettledAt?: number;
  canonicalReason?: string;
}

export class AudioSegmentDispositionLedger {
  private readonly entries = new Map<string, AudioSegmentLedgerEntry>();

  constructor(private readonly maxEntries = 512) {}

  observe({
    identity,
    traceId,
    observedAt = Date.now(),
  }: {
    identity: AudioSegmentIdentity;
    traceId?: string;
    observedAt?: number;
  }): AudioSegmentObservation {
    const key = createAudioSegmentDispositionKey(identity);
    const existing = this.entries.get(key);
    if (existing) {
      existing.observationCount += 1;
      existing.duplicateObservationCount += 1;
      existing.lastObservedAt = observedAt;
      existing.traceId ??= traceId;
      return toObservation(key, existing, "duplicate-observation");
    }

    const entry: AudioSegmentLedgerEntry = {
      identity: { ...identity },
      traceId,
      observationCount: 1,
      duplicateObservationCount: 0,
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
    };
    this.entries.set(key, entry);
    this.prune();
    return toObservation(key, entry, "first-observation");
  }

  settle({
    identity,
    traceId,
    disposition,
    reason,
    settledAt = Date.now(),
  }: {
    identity: AudioSegmentIdentity;
    traceId?: string;
    disposition: AudioSegmentDisposition;
    reason?: string;
    settledAt?: number;
  }): AudioSegmentSettlement {
    const key = createAudioSegmentDispositionKey(identity);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        identity: { ...identity },
        traceId,
        observationCount: 0,
        duplicateObservationCount: 0,
        firstObservedAt: settledAt,
        lastObservedAt: settledAt,
      };
      this.entries.set(key, entry);
      this.prune();
    } else {
      entry.traceId ??= traceId;
    }

    const canonicalCommitted = entry.canonicalDisposition == null;
    if (canonicalCommitted) {
      entry.canonicalDisposition = disposition;
      entry.canonicalSettledAt = settledAt;
      entry.canonicalReason = reason;
    }

    return {
      key,
      identity: { ...entry.identity },
      traceId: entry.traceId,
      proposedDisposition: disposition,
      canonicalDisposition: entry.canonicalDisposition!,
      canonicalCommitted,
      observationCount: entry.observationCount,
      duplicateObservationCount: entry.duplicateObservationCount,
      canonicalSettledAt: entry.canonicalSettledAt!,
      reason: entry.canonicalReason,
    };
  }

  get(identity: AudioSegmentIdentity) {
    const key = createAudioSegmentDispositionKey(identity);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    return {
      key,
      identity: { ...entry.identity },
      traceId: entry.traceId,
      observationCount: entry.observationCount,
      duplicateObservationCount: entry.duplicateObservationCount,
      canonicalDisposition: entry.canonicalDisposition,
      canonicalSettledAt: entry.canonicalSettledAt,
      reason: entry.canonicalReason,
    };
  }

  private prune() {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) return;
      this.entries.delete(oldestKey);
    }
  }
}

export function createAudioSegmentDispositionKey(
  identity: AudioSegmentIdentity
) {
  return [
    identity.captureSessionId,
    identity.captureGeneration,
    identity.segmentSequence,
  ].join(":");
}

export function formatAudioSegmentObservationForTrace(
  observation: AudioSegmentObservation
) {
  return {
    audioSegmentDispositionKey: observation.key,
    audioSegmentObservationDisposition:
      observation.observationDisposition,
    audioSegmentObservationCount: observation.observationCount,
    audioSegmentDuplicateObservationCount:
      observation.duplicateObservationCount,
    audioSegmentCanonicalDisposition:
      observation.canonicalDisposition,
    audioSegmentCanonicalSettledAt:
      observation.canonicalSettledAt,
  };
}

export function formatAudioSegmentSettlementForTrace(
  settlement: AudioSegmentSettlement
) {
  return {
    audioSegmentDispositionKey: settlement.key,
    audioSegmentProposedDisposition: settlement.proposedDisposition,
    audioSegmentCanonicalDisposition:
      settlement.canonicalDisposition,
    audioSegmentCanonicalDispositionCommitted: true,
    audioSegmentSettlementCommitted: settlement.canonicalCommitted,
    audioSegmentObservationCount: settlement.observationCount,
    audioSegmentDuplicateObservationCount:
      settlement.duplicateObservationCount,
    audioSegmentCanonicalSettledAt: settlement.canonicalSettledAt,
    audioSegmentDispositionReason: settlement.reason,
  };
}

function toObservation(
  key: string,
  entry: AudioSegmentLedgerEntry,
  observationDisposition: AudioSegmentObservation["observationDisposition"]
): AudioSegmentObservation {
  return {
    key,
    identity: { ...entry.identity },
    traceId: entry.traceId,
    observationDisposition,
    observationCount: entry.observationCount,
    duplicateObservationCount: entry.duplicateObservationCount,
    canonicalDisposition: entry.canonicalDisposition,
    canonicalSettledAt: entry.canonicalSettledAt,
  };
}
