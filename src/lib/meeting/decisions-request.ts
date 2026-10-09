import { DECISIONS_ENDPOINT, DECISIONS_MODEL, DECISIONS_PROVIDER_ID, type DecisionsProviderSnapshot } from "../../config/decisions.constants.js";
import {
  AIResponseEventBuilder, classifyAIResponseHttpFailure, createAIResponseAttemptIdentity,
  type AIResponseExecutionIdentity, type AIResponseTerminalInput,
} from "../functions/ai-response-events.js";
import { classifyMeetingAIResponseOutcome, MeetingAIResponseOutcomeError } from "./meeting-ai-response.js";
import type { RuntimeInferenceProviderResponse } from "./runtime-inference-response.js";

export interface DecisionsChoiceQuestion<T extends string = string> {
  name: string;
  instructions: string;
  choices: readonly { value: T; description?: string }[];
}

export type DecisionsChoiceResult<T extends string = string> = {
  ok: true;
  choice: T;
  executionScore: number;
  scoreSource: "selected-probability" | "native-confidence";
  nativeConfidence: unknown;
  selectedProbability: unknown;
  scoreFallbackReason?: string;
} | { ok: false; reason: string };

export interface DecisionsRequestResult<T extends string = string> extends RuntimeInferenceProviderResponse {
  decision: DecisionsChoiceResult<T>;
  headersAt?: number;
  decisionReadyAt?: number;
}

export function parseDecisionsChoice<T extends string>(
  raw: string, question: DecisionsChoiceQuestion<T>
): DecisionsChoiceResult<T> {
  let body: any;
  try { body = JSON.parse(raw); } catch { return { ok: false, reason: "invalid-json" }; }
  if (!Array.isArray(body?.answers)) return { ok: false, reason: "invalid-answer-envelope" };
  const matching = body.answers.filter((answer: any) => answer?.name === question.name);
  if (matching.length !== 1) return { ok: false, reason: "answer-identity-mismatch" };
  const answer = matching[0];
  if (answer.type === "refusal") return { ok: false, reason: "refusal" };
  if (answer.type !== "choice" || !question.choices.some(c => c.value === answer.choice)) {
    return { ok: false, reason: "invalid-choice" };
  }
  const unit = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  const probabilities = Array.isArray(answer.probabilities)
    ? answer.probabilities.filter((p: any) => p?.value === answer.choice)
    : [];
  const selectedProbability = probabilities.length === 1 ? probabilities[0].probability : undefined;
  const validProbability = probabilities.length === 1 && unit(selectedProbability);
  if (!validProbability && !unit(answer.confidence)) return { ok: false, reason: "invalid-decision-score" };
  return {
    ok: true, choice: answer.choice, executionScore: validProbability ? selectedProbability : answer.confidence,
    scoreSource: validProbability ? "selected-probability" : "native-confidence",
    nativeConfidence: answer.confidence, selectedProbability,
    scoreFallbackReason: validProbability ? undefined
      : probabilities.length !== 1 ? "selected-probability-not-unique-or-missing" : "selected-probability-invalid",
  };
}

export async function requestDecisionsChoice<T extends string>(input: {
  configuration?: Readonly<DecisionsProviderSnapshot>;
  configurationError?: string;
  question: DecisionsChoiceQuestion<T>;
  modelInput: string;
  executionIdentity: AIResponseExecutionIdentity;
  signal: AbortSignal;
  deadlineAt: number;
  onDispatched?: (at: number) => void;
}): Promise<DecisionsRequestResult<T>> {
  if (!input.question.choices.length || new Set(input.question.choices.map(c => c.value)).size !== input.question.choices.length) {
    throw new Error("Decision choices must be nonempty and unique.");
  }
  const builder = new AIResponseEventBuilder(DECISIONS_PROVIDER_ID,
    createAIResponseAttemptIdentity({ ...input.executionIdentity, modelId: DECISIONS_MODEL }, 1, 1));
  const finish = (terminal: AIResponseTerminalInput, rawOutput = "", headersAt?: number): DecisionsRequestResult<T> => {
    const completedAt = Date.now();
    if (rawOutput) builder.content(rawOutput, completedAt);
    const event = builder.terminal(terminal, completedAt);
    if (event.type !== "terminal") throw new Error("Missing Decisions terminal receipt.");
    if (event.outcome.status === "aborted") {
      const error = new MeetingAIResponseOutcomeError(event.outcome);
      error.name = "AbortError";throw error;
    }
    return {
      rawOutput, providerOutcome: Object.freeze(event.outcome), completedAt, headersAt,
      decisionReadyAt: terminal.status === "success" ? completedAt : undefined,
      providerDisposition: terminal.status === "success" ? "completed-with-content" : classifyMeetingAIResponseOutcome(event.outcome),
      decision: terminal.status === "success" ? parseDecisionsChoice(rawOutput, input.question)
        : { ok: false, reason: terminal.failureClass ?? terminal.status },
    };
  };
  if (input.signal.aborted) return finish({ status: "aborted", retryable: false, completionSignal: "request-abort" });
  if (!input.configuration) return finish({ status: "failed", failureClass: "configuration", retryable: false,
    completionSignal: "request-failure", safeErrorSummary: input.configurationError ?? "OpenAI Decisions is not configured." });
  if (Date.now() >= input.deadlineAt) return finish({ status: "timed-out", retryable: false, completionSignal: "request-timeout" });

  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true;controller.abort(); }, Math.max(0, input.deadlineAt - Date.now()));
  let headersAt: number | undefined;
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => { const error = new Error("Decisions request aborted.");error.name = "AbortError";reject(error); };
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    input.onDispatched?.(Date.now());
    let response: Response;
    let raw: string;
    try {
      ({ response, raw } = await Promise.race([
        (async () => {
          const response = await fetch(DECISIONS_ENDPOINT, {
            method: "POST", signal: controller.signal,
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.configuration!.apiKey}` },
            body: JSON.stringify({ model: input.configuration!.modelId, input: input.modelInput,
              questions: [{ ...input.question, type: "choice" }] }),
          });
          headersAt = Date.now();
          return { response, raw: await response.text() };
        })(),
        aborted,
      ]));
    } catch {
      if (input.signal.aborted) return finish({ status: "aborted", retryable: false, completionSignal: "request-abort" }, "", headersAt);
      if (timedOut) return finish({ status: "timed-out", retryable: false, completionSignal: "request-timeout" }, "", headersAt);
      return finish({ status: "failed", failureClass: "transport", retryable: false, completionSignal: "request-failure",
        safeErrorSummary: "OpenAI Decisions transport failed." }, "", headersAt);
    }
    if (input.signal.aborted) return finish({ status: "aborted", retryable: false, completionSignal: "request-abort" }, "", headersAt);
    if (timedOut || Date.now() >= input.deadlineAt) return finish({ status: "timed-out", retryable: false, completionSignal: "request-timeout" }, "", headersAt);
    if (!response.ok) return finish({ status: "failed", failureClass: classifyAIResponseHttpFailure(response.status),
      statusCode: response.status, retryable: false, completionSignal: "request-failure",
      safeErrorSummary: `OpenAI Decisions request failed (HTTP ${response.status}).` }, "", headersAt);
    const redacted = raw.replaceAll(input.configuration.apiKey, "[REDACTED]");
    try { builder.observeProviderMetadata(JSON.parse(redacted)); } catch { /* The contract parser owns invalid JSON. */ }
    return finish({ status: raw.trim() ? "success" : "empty", retryable: false, completionSignal: "non-streaming-response" }, redacted, headersAt);
  } finally {
    clearTimeout(timer);input.signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}

export function formatDecisionsResultForTrace(result: DecisionsRequestResult, prefix: string) {
  return {
    [`${prefix}Protocol`]: "openai-decisions",
    [`${prefix}ModelId`]: result.providerOutcome.modelId,
    [`${prefix}ProviderId`]: result.providerOutcome.providerId,
    [`${prefix}HeadersAt`]: result.headersAt,
    [`${prefix}DecisionReadyAt`]: result.decisionReadyAt,
    [`${prefix}Choice`]: result.decision.ok ? result.decision.choice : undefined,
    [`${prefix}NativeConfidence`]: result.decision.ok ? result.decision.nativeConfidence : undefined,
    [`${prefix}SelectedProbability`]: result.decision.ok ? result.decision.selectedProbability : undefined,
    [`${prefix}ExecutionScore`]: result.decision.ok ? result.decision.executionScore : undefined,
    [`${prefix}ScoreSource`]: result.decision.ok ? result.decision.scoreSource : undefined,
    [`${prefix}ScoreFallbackReason`]: result.decision.ok ? result.decision.scoreFallbackReason : undefined,
    [`${prefix}DecisionFailureReason`]: result.decision.ok ? undefined : result.decision.reason,
  };
}
