export interface ScreenOperationClaim {
  operationId: string;
  requestedAt: number;
  supersedesOperationId?: string;
  supersedesTraceId?: string;
}

interface ActiveScreenOperation {
  operationId: string;
  requestedAt: number;
  traceId?: string;
}

export class ScreenOperationCoordinator {
  private activeOperation: ActiveScreenOperation | null = null;

  claim(
    operationId: string,
    requestedAt = Date.now()
  ): ScreenOperationClaim {
    const previous = this.activeOperation;
    this.activeOperation = {
      operationId,
      requestedAt,
    };
    return {
      operationId,
      requestedAt,
      supersedesOperationId: previous?.operationId,
      supersedesTraceId: previous?.traceId,
    };
  }

  attachTrace(operationId: string, traceId: string) {
    if (!this.owns(operationId) || !this.activeOperation) return false;
    this.activeOperation.traceId = traceId;
    return true;
  }

  getActiveOperation() {
    return this.activeOperation ? { ...this.activeOperation } : null;
  }

  getActiveOperationId() {
    return this.activeOperation?.operationId ?? null;
  }

  owns(operationId: string) {
    return this.activeOperation?.operationId === operationId;
  }

  release(operationId: string) {
    if (!this.owns(operationId)) return false;
    this.activeOperation = null;
    return true;
  }

  reset() {
    this.activeOperation = null;
  }
}
