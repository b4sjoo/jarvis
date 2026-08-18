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

export interface AIResponseTerminalOutcome {
  status: AIResponseTerminalStatus;
  failureClass?: AIResponseFailureClass;
  retryable: boolean;
  safeErrorSummary?: string;
  statusCode?: number;
  providerId: string;
  startedAt: number;
  firstContentAt?: number;
  finishedAt: number;
  chunkCount: number;
  text?: string;
}

export type AIResponseEvent =
  | {
      type: "content-delta";
      content: string;
      index: number;
      emittedAt: number;
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
  | "finishedAt"
  | "chunkCount"
  | "text"
>;

export class AIResponseEventBuilder {
  private readonly providerId: string;
  private readonly startedAt: number;
  private firstContentAt?: number;
  private chunkCount = 0;
  private text = "";
  private finished = false;

  constructor(providerId: string, startedAt = Date.now()) {
    this.providerId = providerId;
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
    this.chunkCount += 1;
    this.text += content;
    return {
      type: "content-delta",
      content,
      index: this.chunkCount,
      emittedAt,
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
        providerId: this.providerId,
        startedAt: this.startedAt,
        firstContentAt: this.firstContentAt,
        finishedAt,
        chunkCount: this.chunkCount,
        text: input.status === "success" ? this.text : undefined,
      },
    };
  }
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
