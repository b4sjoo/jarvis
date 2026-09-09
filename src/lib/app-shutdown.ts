export const SHUTDOWN_REQUEST_EVENT = "jarvis-shutdown-requested";
export const SHUTDOWN_STATUS_EVENT = "jarvis-shutdown-status";
export const SHUTDOWN_STAGES = [
  "freezing-new-work",
  "draining-runtime-and-capture",
  "finalizing-recording-and-traces",
] as const;

export type ShutdownStage = (typeof SHUTDOWN_STAGES)[number];
export type ShutdownResult = "settled" | "skipped" | "failed-retryable" | "timed-out";
export interface ShutdownRequest {
  generation: number;
  attempt: number;
}
export interface ShutdownStepReceipt {
  stage: ShutdownStage;
  result: ShutdownResult;
  elapsedMs: number;
}
export interface ApplicationShutdownReceipt extends ShutdownRequest {
  origin: string;
  waiting: boolean;
  forced: boolean;
  elapsedMs: number;
  results: ShutdownStepReceipt[];
  unresolvedRecordingFolder: string | null;
}

// These callbacks belong to the mounted main Hook, never the Dashboard WebView.
// drainRuntimeAndCapture must include frontend terminal acceptance, not just IPC Stop.
export interface ApplicationShutdownOwner {
  freezeNewWork(): Promise<"settled" | "skipped">;
  drainRuntimeAndCapture(): Promise<"settled" | "skipped">;
  finalizeRecordingAndTraces(): Promise<"settled" | "skipped">;
  unresolvedRecordingFolder(): string | null;
}

export interface ShutdownTransport {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
}

export function requestApplicationShutdown(transport: Pick<ShutdownTransport, "invoke">) {
  return transport.invoke<void>("exit_app");
}

/** One fixed shutdown operation. Native owns the eight-second waiting/exit authority. */
export class ApplicationShutdownCoordinator {
  private generation: number | undefined;
  private highestAttempt = 0;
  private steps: Array<Promise<ShutdownStepReceipt> | undefined> = [];
  private attempts = new Map<number, Promise<void>>();

  constructor(
    private readonly owner: ApplicationShutdownOwner,
    private readonly transport: Pick<ShutdownTransport, "invoke">,
    private readonly now = Date.now,
  ) {}

  accept(request: ShutdownRequest): Promise<void> {
    if (this.generation !== undefined && this.generation !== request.generation) {
      return Promise.reject(new Error("A shutdown operation already owns this runtime"));
    }
    this.generation = request.generation;
    const existing = this.attempts.get(request.attempt);
    if (existing) return existing;
    if (request.attempt < this.highestAttempt) return Promise.resolve();
    this.highestAttempt = request.attempt;
    const attempt = this.run(request);
    this.attempts.set(request.attempt, attempt);
    return attempt;
  }

  private async run(request: ShutdownRequest) {
    const callbacks = [
      () => this.owner.freezeNewWork(),
      () => this.owner.drainRuntimeAndCapture(),
      () => this.owner.finalizeRecordingAndTraces(),
    ];
    for (const [index, stage] of SHUTDOWN_STAGES.entries()) {
      // Keep in-flight and successful owner calls across retries. Only failures retry.
      const work = this.steps[index] ??= (async (): Promise<ShutdownStepReceipt> => {
        const started = this.now();
        try {
          const result = await callbacks[index]();
          if (result !== "settled" && result !== "skipped") {
            throw new Error("Shutdown owner did not return a terminal result");
          }
          return { stage, result, elapsedMs: this.now() - started };
        } catch {
          return { stage, result: "failed-retryable", elapsedMs: this.now() - started };
        }
      })();
      const result = await work;
      if (result.result === "failed-retryable" && this.steps[index] === work) {
        this.steps[index] = undefined;
      }
      const accepted = await this.transport.invoke<boolean>("report_app_shutdown", {
        ...request,
        receipt: result,
        unresolvedRecordingFolder: this.owner.unresolvedRecordingFolder(),
      });
      // Expired waiters cannot progress to seal or final exit. Retry reuses real work.
      if (!accepted || result.result === "failed-retryable") return;
    }
    await this.transport.invoke("complete_app_shutdown", { ...request });
  }
}

/** Listen before querying to cover Quit during main WebView startup. No polling. */
export async function connectApplicationShutdownOwner(
  coordinator: ApplicationShutdownCoordinator,
  transport: ShutdownTransport,
  onError: (error: unknown) => void,
) {
  const accept = (request: ShutdownRequest) => void coordinator.accept(request).catch(onError);
  const unlisten = await transport.listen<ShutdownRequest>(SHUTDOWN_REQUEST_EVENT, ({ payload }) => accept(payload));
  try {
    const current = await transport.invoke<ApplicationShutdownReceipt | null>("get_app_shutdown");
    if (current?.waiting) accept(current);
    return unlisten;
  } catch (error) {
    unlisten();
    throw error;
  }
}
