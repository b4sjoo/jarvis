import {
  buildDynamicMessages,
  deepVariableReplacer,
  extractVariables,
  getByPath,
  getStreamingContent,
  ImageInput,
} from "./common.function";
import { Message, TYPE_PROVIDER } from "@/types";
import curl2Json from "@bany/curl-to-json";
import { RESPONSE_LENGTHS, LANGUAGES } from "../response-settings.constants";
import { getResponseSettings } from "../storage/response-settings.storage";
import { MARKDOWN_FORMATTING_INSTRUCTIONS } from "@/config/constants";
import {
  AIResponseEventBuilder,
  boundAIResponseErrorText,
  classifyAIResponseHttpFailure,
  coordinateAIResponseAttempts,
  shouldLegacyYieldAIResponseFailure,
  type AIResponseAttemptIdentity,
  type AIResponseEvent,
  type AIResponseExecutionIdentity,
  type AIResponseExecutionIdentityInput,
  type AIResponseRetryPolicy,
  type AIResponseTerminalOutcome,
  type AIResponseTerminalInput,
  type AIResponseProgressBudget,
  type AIResponseBudgetObservation,
} from "./ai-response-events.js";
import { decodeServerSentEventStream } from "./server-sent-event-stream.js";

export type {
  AIResponseEvent,
  AIResponseAttemptIdentity,
  AIResponseExecutionIdentity,
  AIResponseExecutionIdentityInput,
  AIResponseFailureClass,
  AIResponseRetryPolicy,
  AIResponseTerminalOutcome,
  AIResponseTerminalStatus,
} from "./ai-response-events.js";

export interface AIResponseRequestOptions {
  timeoutMs?: number;
  progressBudget?: AIResponseProgressBudget;
  onBudgetObservation?: (observation: AIResponseBudgetObservation) => void;
  maxOutputTokens?: number;
  retryPolicy?: AIResponseRetryPolicy;
  isExecutionCurrent?: (identity: AIResponseAttemptIdentity) => boolean;
  readRetryDeadlineAt?: () => number | undefined;
  retryCompletedOutput?: (outcome: Readonly<AIResponseTerminalOutcome>) => boolean;
}

export type AIResponseParams = {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  systemPrompt?: string;
  history?: Message[];
  userMessage: string;
  imagesBase64?: Array<string | ImageInput>;
  signal?: AbortSignal;
  applyResponseSettings?: boolean;
  requestOptions?: AIResponseRequestOptions;
  executionIdentity?: AIResponseExecutionIdentityInput;
};

function buildEnhancedSystemPrompt(
  baseSystemPrompt?: string,
  applyResponseSettings = true
): string {
  const prompts: string[] = [];

  if (baseSystemPrompt) {
    prompts.push(baseSystemPrompt);
  }

  if (applyResponseSettings) {
    const responseSettings = getResponseSettings();

    const lengthOption = RESPONSE_LENGTHS.find(
      (l) => l.id === responseSettings.responseLength
    );
    if (lengthOption?.prompt?.trim()) {
      prompts.push(lengthOption.prompt);
    }

    const languageOption = LANGUAGES.find(
      (l) => l.id === responseSettings.language
    );
    if (languageOption?.prompt?.trim()) {
      prompts.push(languageOption.prompt);
    }
  }

  // Add markdown formatting instructions
  prompts.push(MARKDOWN_FORMATTING_INSTRUCTIONS);

  return prompts.join(" ");
}

export async function* fetchAIResponseEvents(
  params: AIResponseParams
): AsyncIterable<AIResponseEvent> {
  const identity = resolveAIResponseExecutionIdentity(params);
  const providerId =
    params.provider?.id ?? params.selectedProvider?.provider ?? "unknown";
  const requestDeadlineAt = Date.now() + (params.requestOptions?.timeoutMs ?? Infinity);
  const readRetryDeadlineAt = params.requestOptions?.readRetryDeadlineAt
    ? () => Math.min(params.requestOptions!.readRetryDeadlineAt!() ?? -Infinity, requestDeadlineAt)
    : undefined;
  yield* coordinateAIResponseAttempts({
    identity,
    providerId,
    retryPolicy: params.requestOptions?.retryPolicy,
    signal: params.signal,
    isExecutionCurrent: params.requestOptions?.isExecutionCurrent,
    readRetryDeadlineAt,
    retryCompletedOutput: params.requestOptions?.retryCompletedOutput,
    runAttempt: (attemptIdentity) =>
      fetchAIResponseAttemptEvents(
        attemptIdentity.attemptNumber > 1 && readRetryDeadlineAt
          ? { ...params, requestOptions: {
              ...params.requestOptions,
              timeoutMs: Math.max(1, readRetryDeadlineAt() - Date.now()),
            } }
          : params,
        attemptIdentity
      ),
  });
}

async function* fetchAIResponseAttemptEvents(
  params: AIResponseParams,
  attemptIdentity: AIResponseAttemptIdentity
): AsyncIterable<AIResponseEvent> {
  let cleanupRequestSignal = () => {};
  const providerId =
    params.provider?.id ?? params.selectedProvider?.provider ?? "unknown";
  const startedAt = Date.now();
  const eventBuilder = new AIResponseEventBuilder(
    providerId,
    attemptIdentity,
    startedAt
  );
  let requestSignal: ReturnType<typeof createRequestSignal> | undefined;
  const terminal = (input: AIResponseTerminalInput) => {
    const aborted = params.requestOptions?.progressBudget && requestSignal?.signal?.aborted;
    const outcome = aborted ? requestSignal!.abortOutcome() : input;
    cleanupRequestSignal();
    return eventBuilder.terminal({ ...outcome, ...requestSignal?.budgetOutcome() });
  };

  try {
    const {
      provider,
      selectedProvider,
      systemPrompt,
      history = [],
      userMessage,
      imagesBase64 = [],
      signal,
      applyResponseSettings = true,
      requestOptions,
    } = params;
    requestSignal = createRequestSignal(signal, requestOptions, startedAt, attemptIdentity);
    cleanupRequestSignal = requestSignal.cleanup;

    // Check if already aborted
    if (requestSignal.signal?.aborted) {
      yield terminal(requestSignal.abortOutcome());
      return;
    }

    const enhancedSystemPrompt = buildEnhancedSystemPrompt(
      systemPrompt,
      applyResponseSettings
    );

    if (!provider) {
      throw new Error(`Provider not provided`);
    }
    if (!selectedProvider) {
      throw new Error(`Selected provider not provided`);
    }

    let curlJson;
    try {
      curlJson = curl2Json(provider.curl);
    } catch (error) {
      throw new Error(
        `Failed to parse curl: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }

    const extractedVariables = extractVariables(provider.curl);
    const requiredVars = extractedVariables.filter(
      ({ key }) => key !== "SYSTEM_PROMPT" && key !== "TEXT" && key !== "IMAGE"
    );
    for (const { key } of requiredVars) {
      if (
        !selectedProvider.variables?.[key] ||
        selectedProvider.variables[key].trim() === ""
      ) {
        throw new Error(
          `Missing required variable: ${key}. Please configure it in settings.`
        );
      }
    }

    if (!userMessage) {
      throw new Error("User message is required");
    }
    if (imagesBase64.length > 0 && !provider.curl.includes("{{IMAGE}}")) {
      throw new Error(
        `Provider ${provider?.id ?? "unknown"} does not support image input`
      );
    }

    let bodyObj: any = curlJson.data
      ? JSON.parse(JSON.stringify(curlJson.data))
      : {};
    const messagesKey = Object.keys(bodyObj).find((key) =>
      ["messages", "contents", "conversation", "history"].includes(key)
    );

    if (messagesKey && Array.isArray(bodyObj[messagesKey])) {
      const finalMessages = buildDynamicMessages(
        bodyObj[messagesKey],
        history,
        userMessage,
        imagesBase64
      );
      bodyObj[messagesKey] = finalMessages;
    }

    const allVariables = {
      ...Object.fromEntries(
        Object.entries(selectedProvider.variables).map(([key, value]) => [
          key.toUpperCase(),
          value,
        ])
      ),
      SYSTEM_PROMPT: enhancedSystemPrompt || "",
      IMAGE_MEDIA_TYPE: getFirstImageMediaType(imagesBase64),
    };

    bodyObj = deepVariableReplacer(bodyObj, allVariables);
    let url = deepVariableReplacer(curlJson.url || "", allVariables);
    applyAIRequestOptionsToBody(bodyObj, provider, url, requestOptions);

    const headers = deepVariableReplacer(curlJson.header || {}, allVariables);
    headers["Content-Type"] = "application/json";

    if (provider?.streaming) {
      if (typeof bodyObj === "object" && bodyObj !== null) {
        const streamKey = Object.keys(bodyObj).find(
          (k) => k.toLowerCase() === "stream"
        );
        if (streamKey) {
          bodyObj[streamKey] = true;
        } else {
          bodyObj.stream = true;
        }
      }
    }

    let response;
    try {
      response = await fetch(url, {
        method: curlJson.method || "POST",
        headers,
        body: curlJson.method === "GET" ? undefined : JSON.stringify(bodyObj),
        signal: requestSignal.signal,
      });
    } catch (fetchError) {
      // Check if aborted
      if (
        requestSignal.signal?.aborted ||
        (fetchError instanceof Error && fetchError.name === "AbortError")
      ) {
        yield terminal(requestSignal.abortOutcome());
        return;
      }
      yield terminal({
        status: "failed",
        failureClass: "transport",
        retryable: true,
        completionSignal: "request-failure",
        safeErrorSummary: `Network error during API request: ${
          fetchError instanceof Error ? fetchError.message : "Unknown error"
        }`,
      });
      return;
    }

    if (requestOptions?.progressBudget && requestSignal.signal?.aborted) {
      yield terminal(requestSignal.abortOutcome());
      return;
    }

    if (!response.ok) {
      let errorText = "";
      try {
        errorText = await response.text();
      } catch {}
      const failureClass = classifyAIResponseHttpFailure(response.status);
      yield terminal({
        status: "failed",
        failureClass,
        retryable:
          failureClass === "rate-limit" || response.status >= 500,
        completionSignal: "request-failure",
        statusCode: response.status,
        safeErrorSummary: `API request failed: ${response.status} ${response.statusText}${
          errorText ? ` - ${boundAIResponseErrorText(errorText)}` : ""
        }`,
      });
      return;
    }

    if (!provider?.streaming) {
      let json;
      try {
        json = await response.json();
      } catch (parseError) {
        yield terminal({
          status: "failed",
          failureClass: "provider-response-parse",
          retryable: false,
          completionSignal: "request-failure",
          safeErrorSummary: `Failed to parse non-streaming response: ${
            parseError instanceof Error ? parseError.message : "Unknown error"
          }`,
        });
        return;
      }
      eventBuilder.observeProviderMetadata(json);
      const candidateContent = getByPath(
        json,
        provider?.responseContentPath || ""
      );
      const content =
        typeof candidateContent === "string" ? candidateContent : "";
      if (requestOptions?.progressBudget && requestSignal.signal?.aborted) {
        yield terminal(requestSignal.abortOutcome());
        return;
      }
      if (content) {
        requestSignal.contentReceived();
        yield eventBuilder.content(content);
        yield terminal({
          status: "success",
          retryable: false,
          completionSignal: "non-streaming-response",
        });
      } else {
        yield terminal({
          status: "empty",
          retryable: false,
          completionSignal: "non-streaming-response",
        });
      }
      return;
    }

    if (!response.body) {
      yield terminal({
        status: "failed",
        failureClass: "stream-unavailable",
        retryable: false,
        completionSignal: "request-failure",
        safeErrorSummary: "Streaming not supported or response body missing",
      });
      return;
    }

    let streamCompletionSignal:
      | "stream-eof"
      | "openai-done"
      | "anthropic-message-stop"
      | undefined;
    try {
      for await (const streamEvent of decodeServerSentEventStream({
        body: response.body,
        signal: requestSignal.signal,
      })) {
        if (requestOptions?.progressBudget && requestSignal.signal?.aborted) {
          throw new DOMException("AI response stream aborted", "AbortError");
        }
        if (streamEvent.type === "complete") {
          streamCompletionSignal = streamEvent.signal;
          continue;
        }
        try {
          const parsed = JSON.parse(streamEvent.data);
          eventBuilder.observeProviderMetadata(parsed);
          const delta = getStreamingContent(
            parsed,
            provider?.responseContentPath || ""
          );
          if (delta) {
            requestSignal.contentReceived();
            yield eventBuilder.content(delta);
          }
        } catch {
          // Ignore malformed provider data events without weakening terminal handling.
        }
      }
    } catch (readError) {
      if (
        requestSignal.signal?.aborted ||
        (readError instanceof Error && readError.name === "AbortError")
      ) {
        yield terminal(requestSignal.abortOutcome());
        return;
      }
      yield terminal({
        status: "failed",
        failureClass: "stream-read",
        retryable: true,
        completionSignal: "request-failure",
        safeErrorSummary: `Error reading stream: ${
          readError instanceof Error ? readError.message : "Unknown error"
        }`,
      });
      return;
    }
    yield terminal(
      eventBuilder.hasContent
        ? {
            status: "success",
            retryable: false,
            completionSignal: streamCompletionSignal ?? "stream-eof",
          }
        : {
            status: "empty",
            retryable: false,
            completionSignal: streamCompletionSignal ?? "stream-eof",
          }
    );
  } catch (error) {
    yield terminal({
      status: "failed",
      failureClass: "configuration",
      retryable: false,
      completionSignal: "request-failure",
      safeErrorSummary:
        error instanceof Error ? error.message : "Unknown error",
    });
  } finally {
    cleanupRequestSignal();
  }
}

export async function* fetchAIResponse(
  params: AIResponseParams
): AsyncIterable<string> {
  const legacyParams: AIResponseParams = {
    ...params,
    requestOptions: {
      ...params.requestOptions,
      retryPolicy: { maxAttempts: 1 },
      isExecutionCurrent: undefined,
    },
  };
  for await (const event of fetchAIResponseEvents(legacyParams)) {
    if (event.type === "content-delta") {
      yield event.content;
      continue;
    }
    const outcome = event.outcome;
    if (!outcome.final) continue;
    if (
      outcome.status === "success" ||
      outcome.status === "empty" ||
      outcome.status === "aborted"
    ) {
      return;
    }
    const summary = outcome.safeErrorSummary ?? "Unknown error";
    if (
      outcome.status === "timed-out" ||
      !shouldLegacyYieldAIResponseFailure(outcome.failureClass)
    ) {
      throw new Error(`Error in fetchAIResponse: ${summary}`);
    }
    yield summary;
    return;
  }
}

function resolveAIResponseExecutionIdentity(
  params: AIResponseParams
): AIResponseExecutionIdentity {
  const requestId =
    params.executionIdentity?.requestId ?? createAIResponseRequestId();
  return {
    requestId,
    executionPlanId:
      params.executionIdentity?.executionPlanId ?? requestId,
    modelId:
      params.executionIdentity?.modelId ?? inferAIResponseModelId(params),
    sessionId: params.executionIdentity?.sessionId ?? "unscoped",
    runtimeEpoch: Math.max(
      0,
      Math.floor(params.executionIdentity?.runtimeEpoch ?? 0)
    ),
    logicalQuestionUnitId:
      params.executionIdentity?.logicalQuestionUnitId ?? "unscoped",
    logicalQuestionRevision: Math.max(
      0,
      Math.floor(params.executionIdentity?.logicalQuestionRevision ?? 0)
    ),
  };
}

function inferAIResponseModelId(params: AIResponseParams) {
  const variables = params.selectedProvider?.variables ?? {};
  return (
    variables.MODEL ??
    variables.MODEL_ID ??
    variables.model ??
    variables.modelId ??
    params.selectedProvider?.provider ??
    params.provider?.id ??
    "unknown"
  );
}

function createAIResponseRequestId() {
  const suffix =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return `ai_response_${suffix}`;
}

function getFirstImageMediaType(images: Array<string | ImageInput>) {
  const firstImage = images[0];
  if (typeof firstImage === "object" && firstImage?.mediaType) {
    return firstImage.mediaType;
  }

  return "image/png";
}

function createRequestSignal(
  externalSignal: AbortSignal | undefined,
  options: AIResponseRequestOptions | undefined,
  startedAt: number,
  identity: AIResponseAttemptIdentity
) {
  const timeoutMs = options?.timeoutMs;
  const budget = options?.progressBudget;
  const controller = (timeoutMs && timeoutMs > 0) || budget ? new AbortController() : undefined;
  const signal = controller?.signal ?? externalSignal;
  let closed = false;
  let timedOut = false;
  let lastContentAt: number | undefined;
  let budgetTimeout: AIResponseBudgetObservation | undefined;
  let totalElapsedWarningAt: number | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let progressId: ReturnType<typeof setTimeout> | undefined;
  let warningId: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    globalThis.clearTimeout(timeoutId);
    globalThis.clearTimeout(progressId);
    globalThis.clearTimeout(warningId);
    externalSignal?.removeEventListener("abort", abortFromExternalSignal);
  };
  const abortFromExternalSignal = () => { cleanup(); controller?.abort(); };
  const observe = (kind: AIResponseBudgetObservation["kind"], limitMs: number, deadlineAt: number) => ({
    requestId: identity.requestId, attemptId: identity.attemptId,
    kind, limitMs, startedAt, deadlineAt, observedAt: Date.now(), lastContentAt,
  });
  const notify = (observation: AIResponseBudgetObservation) => {
    try { options?.onBudgetObservation?.(observation); }
    catch { console.warn("AI response budget observation callback failed"); }
  };
  const expireProgress = () => {
    if (closed || signal?.aborted || !budget) return;
    const kind = lastContentAt === undefined ? "first-content" : "content-idle";
    const limitMs = lastContentAt === undefined ? budget.firstContentTimeoutMs : budget.contentIdleTimeoutMs;
    const deadlineAt = (lastContentAt ?? startedAt) + limitMs;
    const remaining = deadlineAt - Date.now();
    if (remaining > 0) {
      progressId = globalThis.setTimeout(expireProgress, remaining);
      return;
    }
    timedOut = true;
    budgetTimeout = observe(kind, limitMs, deadlineAt);
    cleanup();
    controller?.abort();
    notify(budgetTimeout);
  };

  if (externalSignal?.aborted) {
    abortFromExternalSignal();
  } else if (controller) {
    externalSignal?.addEventListener("abort", abortFromExternalSignal, {
      once: true,
    });
  }
  if (!closed && controller) {
    if (timeoutMs && timeoutMs > 0) timeoutId = globalThis.setTimeout(() => {
      if (closed || signal?.aborted) return;
      timedOut = true;
      cleanup();
      controller.abort();
    }, timeoutMs);
    if (budget) {
      progressId = globalThis.setTimeout(expireProgress, Math.max(0, startedAt + budget.firstContentTimeoutMs - Date.now()));
      warningId = globalThis.setTimeout(() => {
        if (closed || signal?.aborted) return;
        const observation = observe("total-elapsed", budget.totalElapsedWarningMs, startedAt + budget.totalElapsedWarningMs);
        totalElapsedWarningAt = observation.observedAt;
        notify(observation);
      }, Math.max(0, startedAt + budget.totalElapsedWarningMs - Date.now()));
    }
  }

  return {
    signal,
    cleanup,
    contentReceived: () => {
      if (!budget || closed || signal?.aborted) return;
      const first = lastContentAt === undefined;
      lastContentAt = Date.now();
      // Later chunks only advance the deadline; the existing timer checks it.
      if (first) {
        globalThis.clearTimeout(progressId);
        progressId = globalThis.setTimeout(expireProgress, budget.contentIdleTimeoutMs);
      }
    },
    budgetOutcome: () => ({
      ...(budgetTimeout ? { budgetTimeout } : {}),
      ...(totalElapsedWarningAt !== undefined ? { totalElapsedWarningAt } : {}),
    }),
    abortOutcome: (): AIResponseTerminalInput => timedOut ? {
      status: "timed-out", retryable: true, completionSignal: "request-timeout",
      safeErrorSummary: budgetTimeout
        ? `AI request timed out after ${budgetTimeout.limitMs}ms without ${budgetTimeout.kind === "first-content" ? "first content" : "content progress"}.`
        : `AI request timed out after ${timeoutMs}ms.`,
    } : { status: "aborted", retryable: false, completionSignal: "request-abort" },
  };
}

function applyAIRequestOptionsToBody(
  bodyObj: any,
  provider: TYPE_PROVIDER,
  url: string,
  requestOptions: AIResponseRequestOptions | undefined
) {
  if (!requestOptions?.maxOutputTokens || !bodyObj || typeof bodyObj !== "object") {
    return;
  }

  const maxOutputTokens = Math.max(
    1,
    Math.floor(requestOptions.maxOutputTokens)
  );
  const hasOwn = (key: string) =>
    Object.prototype.hasOwnProperty.call(bodyObj, key);

  if (hasOwn("max_completion_tokens")) {
    bodyObj.max_completion_tokens = maxOutputTokens;
    return;
  }

  if (hasOwn("max_tokens")) {
    bodyObj.max_tokens = maxOutputTokens;
    return;
  }

  if (
    bodyObj.generationConfig &&
    typeof bodyObj.generationConfig === "object"
  ) {
    bodyObj.generationConfig.maxOutputTokens = maxOutputTokens;
    return;
  }

  switch (provider.id) {
    case "openai":
    case "groq":
      bodyObj.max_completion_tokens = maxOutputTokens;
      return;
    case "claude":
    case "gemini":
    case "grok":
    case "mistral":
    case "perplexity":
    case "openrouter":
    case "ollama":
    case "cohere":
      bodyObj.max_tokens = maxOutputTokens;
      return;
    default:
      break;
  }

  if (url.includes("/chat/completions")) {
    bodyObj.max_completion_tokens = maxOutputTokens;
  }
}
