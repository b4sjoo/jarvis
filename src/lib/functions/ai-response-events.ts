export type AIResponseTerminalStatus =
  | "success"
  | "empty"
  | "failed"
  | "timed-out"
  | "aborted";

export type AIResponseFailureClass =
  | "configuration"
  | "transport"
  | "authentication"
  | "rate-limit"
  | "provider-http"
  | "provider-response-parse"
  | "stream-unavailable"
  | "stream-read"
  | "unexpected";

export type AIResponseAttemptDisposition =
  | "accepted"
  | "retrying"
  | "stale";

export type AIResponseCompletionSignal =
  | "non-streaming-response"
  | "stream-eof"
  | "openai-done"
  | "anthropic-message-stop"
  | "request-timeout"
  | "request-abort"
  | "request-failure";

export interface AIResponseExecutionIdentity {
  requestId: string;
  executionPlanId: string;
  modelId: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
}

export interface AIResponseExecutionIdentityInput {
  requestId?: string;
  executionPlanId?: string;
  modelId?: string;
  sessionId?: string;
  runtimeEpoch?: number;
  logicalQuestionUnitId?: string;
  logicalQuestionRevision?: number;
}

export interface AIResponseAttemptIdentity
  extends AIResponseExecutionIdentity {
  attemptId: string;
  attemptNumber: number;
  maxAttempts: number;
}

export interface AIResponseRetryPolicy {
  maxAttempts?: number;
  retryDelayMs?: number;
  retryTimeouts?: boolean;
  retryableFailureClasses?: AIResponseFailureClass[];
}

export interface NormalizedAIResponseRetryPolicy {
  maxAttempts: number;
  retryDelayMs: number;
  retryTimeouts: boolean;
  retryableFailureClasses: AIResponseFailureClass[];
}

export interface AIResponseTerminalOutcome {
  requestId: string;
  attemptId: string;
  executionPlanId: string;
  modelId: string;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionRevision: number;
  attemptNumber: number;
  maxAttempts: number;
  final: boolean;
  disposition: AIResponseAttemptDisposition;
  status: AIResponseTerminalStatus;
  failureClass?: AIResponseFailureClass;
  retryable: boolean;
  safeErrorSummary?: string;
  statusCode?: number;
  providerId: string;
  startedAt: number;
  firstContentAt?: number;
  lastContentAt?: number;
  finishedAt: number;
  chunkCount: number;
  observedContentChars?: number;
  observedContentHash?: string;
  completionSignal?: AIResponseCompletionSignal;
  text?: string;
}

export type AIResponseEvent =
  | {
      type: "content-delta";
      content: string;
      index: number;
      emittedAt: number;
      requestId: string;
      attemptId: string;
      attemptNumber: number;
    }
  | {
      type: "terminal";
      outcome: AIResponseTerminalOutcome;
    };

export type AIResponseTerminalInput = Omit<
  AIResponseTerminalOutcome,
  | "providerId"
  | "startedAt"
  | "firstContentAt"
  | "lastContentAt"
  | "finishedAt"
  | "chunkCount"
  | "observedContentChars"
  | "observedContentHash"
  | "requestId"
  | "attemptId"
  | "executionPlanId"
  | "modelId"
  | "sessionId"
  | "runtimeEpoch"
  | "logicalQuestionUnitId"
  | "logicalQuestionRevision"
  | "attemptNumber"
  | "maxAttempts"
  | "final"
  | "disposition"
  | "text"
>;

export class AIResponseEventBuilder {
  private readonly providerId: string;
  private readonly identity: AIResponseAttemptIdentity;
  private readonly startedAt: number;
  private firstContentAt?: number;
  private lastContentAt?: number;
  private chunkCount = 0;
  private text = "";
  private finished = false;

  constructor(
    providerId: string,
    identity: AIResponseAttemptIdentity,
    startedAt = Date.now()
  ) {
    this.providerId = providerId;
    this.identity = identity;
    this.startedAt = startedAt;
  }

  get hasContent() {
    return this.text.length > 0;
  }

  content(content: string, emittedAt = Date.now()): AIResponseEvent {
    if (this.finished) {
      throw new Error("AI response event stream is already terminal");
    }
    if (!content) {
      throw new Error("AI response content delta cannot be empty");
    }
    this.firstContentAt ??= emittedAt;
    this.lastContentAt = emittedAt;
    this.chunkCount += 1;
    this.text += content;
    return {
      type: "content-delta",
      content,
      index: this.chunkCount,
      emittedAt,
      requestId: this.identity.requestId,
      attemptId: this.identity.attemptId,
      attemptNumber: this.identity.attemptNumber,
    };
  }

  terminal(
    input: AIResponseTerminalInput,
    finishedAt = Date.now()
  ): AIResponseEvent {
    if (this.finished) {
      throw new Error("AI response terminal outcome already emitted");
    }
    if (input.status === "success" && !this.text) {
      throw new Error("Successful AI response requires content");
    }
    if (input.status === "failed" && !input.failureClass) {
      throw new Error("Failed AI response requires a failure class");
    }
    this.finished = true;
    return {
      type: "terminal",
      outcome: {
        ...input,
        ...this.identity,
        final: true,
        disposition: "accepted",
        providerId: this.providerId,
        startedAt: this.startedAt,
        firstContentAt: this.firstContentAt,
        lastContentAt: this.lastContentAt,
        finishedAt,
        chunkCount: this.chunkCount,
        observedContentChars: this.text.length,
        observedContentHash: this.text
          ? hashObservedAIResponseContent(this.text)
          : undefined,
        text: input.status === "success" ? this.text : undefined,
      },
    };
  }
}

function hashObservedAIResponseContent(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export async function* coordinateAIResponseAttempts(input: {
  identity: AIResponseExecutionIdentity;
  providerId?: string;
  retryPolicy?: AIResponseRetryPolicy;
  signal?: AbortSignal;
  isExecutionCurrent?: (identity: AIResponseAttemptIdentity) => boolean;
  runAttempt: (
    identity: AIResponseAttemptIdentity
  ) => AsyncIterable<AIResponseEvent>;
}): AsyncIterable<AIResponseEvent> {
  const policy = normalizeAIResponseRetryPolicy(input.retryPolicy);
  for (
    let attemptNumber = 1;
    attemptNumber <= policy.maxAttempts;
    attemptNumber += 1
  ) {
    const attemptIdentity = createAIResponseAttemptIdentity(
      input.identity,
      attemptNumber,
      policy.maxAttempts
    );
    let terminalSeen = false;
    let retry = false;
    try {
      for await (const event of input.runAttempt(attemptIdentity)) {
        if (event.type === "content-delta") {
          yield {
            ...event,
            requestId: attemptIdentity.requestId,
            attemptId: attemptIdentity.attemptId,
            attemptNumber: attemptIdentity.attemptNumber,
          };
          continue;
        }
        if (terminalSeen) {
          throw new Error(
            "AI response attempt emitted multiple terminal outcomes"
          );
        }
        const outcome = bindAIResponseOutcomeToAttempt(
          event.outcome,
          attemptIdentity
        );
        const current =
          input.isExecutionCurrent?.(attemptIdentity) ?? true;
        terminalSeen = true;
        if (!current) {
          yield {
            type: "terminal",
            outcome: {
              ...outcome,
              final: true,
              disposition: "stale",
            },
          };
          return;
        }
        retry = shouldRetryAIResponseOutcome(outcome, policy);
        yield {
          type: "terminal",
          outcome: {
            ...outcome,
            final: !retry,
            disposition: retry ? "retrying" : "accepted",
          },
        };
      }
    } catch (error) {
      if (terminalSeen) throw error;
      terminalSeen = true;
      const builder = new AIResponseEventBuilder(
        input.providerId ?? "unknown",
        attemptIdentity
      );
      yield builder.terminal({
        status: "failed",
        failureClass: "unexpected",
        retryable: false,
        completionSignal: "request-failure",
        safeErrorSummary:
          error instanceof Error
            ? boundAIResponseErrorText(error.message)
            : "Unexpected AI response attempt failure",
      });
    }
    if (!terminalSeen) {
      const builder = new AIResponseEventBuilder(
        input.providerId ?? "unknown",
        attemptIdentity
      );
      yield builder.terminal({
        status: "failed",
        failureClass: "unexpected",
        retryable: false,
        completionSignal: "request-failure",
        safeErrorSummary: "AI response attempt ended without a terminal outcome",
      });
      return;
    }
    if (!retry) return;
    const retryReady = await waitForAIResponseRetry(
      policy.retryDelayMs,
      input.signal
    );
    if (!retryReady) {
      const abortedIdentity = createAIResponseAttemptIdentity(
        input.identity,
        attemptNumber + 1,
        policy.maxAttempts
      );
      const builder = new AIResponseEventBuilder(
        input.providerId ?? "unknown",
        abortedIdentity
      );
      yield builder.terminal({
        status: "aborted",
        retryable: false,
        completionSignal: "request-abort",
      });
      return;
    }
  }
}

export function createAIResponseAttemptIdentity(
  identity: AIResponseExecutionIdentity,
  attemptNumber: number,
  maxAttempts: number
): AIResponseAttemptIdentity {
  return {
    ...identity,
    attemptId: `${identity.requestId}:attempt:${attemptNumber}:${createAIResponseIdentitySuffix()}`,
    attemptNumber,
    maxAttempts,
  };
}

export function normalizeAIResponseRetryPolicy(
  policy: AIResponseRetryPolicy | undefined
): NormalizedAIResponseRetryPolicy {
  const requestedAttempts = Number.isFinite(policy?.maxAttempts)
    ? Math.floor(policy?.maxAttempts ?? 1)
    : 1;
  const requestedDelay = Number.isFinite(policy?.retryDelayMs)
    ? Math.floor(policy?.retryDelayMs ?? 0)
    : 0;
  const maxAttempts = Math.max(
    1,
    Math.min(3, requestedAttempts)
  );
  return {
    maxAttempts,
    retryDelayMs: Math.max(0, Math.min(2_000, requestedDelay)),
    retryTimeouts: policy?.retryTimeouts ?? false,
    retryableFailureClasses:
      policy?.retryableFailureClasses ??
      ["transport", "rate-limit", "provider-http", "stream-read"],
  };
}

export function shouldRetryAIResponseOutcome(
  outcome: AIResponseTerminalOutcome,
  policy: NormalizedAIResponseRetryPolicy
) {
  if (outcome.attemptNumber >= policy.maxAttempts) return false;
  if (outcome.status === "timed-out") return policy.retryTimeouts;
  return Boolean(
    outcome.status === "failed" &&
      outcome.retryable &&
      outcome.failureClass &&
      policy.retryableFailureClasses.includes(outcome.failureClass)
  );
}

function bindAIResponseOutcomeToAttempt(
  outcome: AIResponseTerminalOutcome,
  identity: AIResponseAttemptIdentity
): AIResponseTerminalOutcome {
  return {
    ...outcome,
    ...identity,
  };
}

export function classifyAIResponseHttpFailure(
  statusCode: number
): AIResponseFailureClass {
  if (statusCode === 401 || statusCode === 403) {
    return "authentication";
  }
  if (statusCode === 429) {
    return "rate-limit";
  }
  return "provider-http";
}

export function shouldLegacyYieldAIResponseFailure(
  failureClass: AIResponseFailureClass | undefined
) {
  return (
    failureClass !== "configuration" && failureClass !== "unexpected"
  );
}

export function boundAIResponseErrorText(value: string) {
  return value.replace(/\s+/gu, " ").trim().slice(0, 1_000);
}

async function waitForAIResponseRetry(
  delayMs: number,
  signal: AbortSignal | undefined
) {
  if (signal?.aborted) return false;
  if (delayMs <= 0) return true;
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      globalThis.clearTimeout(timeoutId);
      resolve(false);
    };
    const timeoutId = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createAIResponseIdentitySuffix() {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
