export type TaxonomyAdjudicationCircuitReason =
  | "provider-auth-error"
  | "provider-configuration-error";

export interface TaxonomyAdjudicationCircuitState {
  sessionId: string;
  open: boolean;
  reason?: TaxonomyAdjudicationCircuitReason;
  detail?: string;
  openedAt?: number;
}

export class TaxonomyAdjudicationSessionCircuitBreaker {
  private state?: TaxonomyAdjudicationCircuitState;

  read(sessionId: string): TaxonomyAdjudicationCircuitState {
    this.ensureSession(sessionId);
    return { ...this.state! };
  }

  open(input: {
    sessionId: string;
    reason: TaxonomyAdjudicationCircuitReason;
    detail?: string;
    now?: number;
  }) {
    this.ensureSession(input.sessionId);
    if (this.state?.open) {
      return { state: { ...this.state }, newlyOpened: false };
    }
    this.state = {
      sessionId: input.sessionId,
      open: true,
      reason: input.reason,
      detail: input.detail,
      openedAt: input.now ?? Date.now(),
    };
    return { state: { ...this.state }, newlyOpened: true };
  }

  private ensureSession(sessionId: string) {
    if (this.state?.sessionId === sessionId) return;
    this.state = { sessionId, open: false };
  }
}

export function shouldOpenTaxonomyAdjudicationCircuit(input: {
  leaseAuthorized: boolean;
  providerDisposition: string;
}) {
  return (
    input.leaseAuthorized &&
    input.providerDisposition === "provider-auth-error"
  );
}

export function formatTaxonomyAdjudicationCircuitForTrace(
  state: TaxonomyAdjudicationCircuitState,
  newlyOpened = false
) {
  return {
    taxonomyAdjudicationCircuitOpen: state.open,
    taxonomyAdjudicationCircuitReason: state.reason,
    taxonomyAdjudicationCircuitDetail: state.detail,
    taxonomyAdjudicationCircuitOpenedAt: state.openedAt,
    taxonomyAdjudicationCircuitNewlyOpened: newlyOpened,
  };
}
