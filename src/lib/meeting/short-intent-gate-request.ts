import { requestRuntimeInferenceResponse } from "./runtime-inference-request.js";
import type {
  AIResponseExecutionIdentityInput,
  AIResponseTerminalOutcome,
} from "../functions/ai-response-events.js";
import type { TYPE_PROVIDER } from "@/types";
import type { SelectedProviderState } from "./types.js";
import {
  buildResponseOpportunityPrompts,
  parseResponseOpportunityOutput,
  resolveResponseOpportunityTargetIndexes,
  type ResponseOpportunityParseResult,
  type ResponseOpportunityRequest,
} from "./short-intent-gate.js";
import { getRuntimeInferenceOperationDefinition } from "./runtime-inference.js";
import { requestDecisionsChoice, formatDecisionsResultForTrace } from "./decisions-request.js";
import { createDecisionsExecutionIdentity, type RuntimeDecisionBackend } from "./decisions-runtime.js";
import { runDecisionProviderRequest } from "./decision-provider-request.js";
import { requestDecisionsEvidence } from "./decisions-evidence-request.js";
import { parseRuntimeJsonObject } from "./runtime-json-object.js";
import type { RuntimeInferenceProviderAdmissionCoordinator } from "./runtime-inference-provider-admission.js";
import { RESPONSE_OPPORTUNITY_GENERATION_WAIT_MS } from "./response-opportunity-generation-gate.js";

const OPERATION = getRuntimeInferenceOperationDefinition(
  "response-opportunity-inference"
);

export interface ResponseOpportunityRequestResult {
  rawOutput: string;
  parsed: ResponseOpportunityParseResult;
  providerDisposition:
    | "completed-with-content"
    | "completed-empty"
    | "provider-error-content"
    | "provider-auth-error";
  parseDisposition: string;
  providerOutcome?: Readonly<AIResponseTerminalOutcome>;
  firstTokenAt?: number;
  completedAt: number;
  decisionMetadata?: Record<string, unknown>;
}

export async function requestResponseOpportunity(input: {
  request: ResponseOpportunityRequest;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  signal: AbortSignal;
  executionIdentity?: AIResponseExecutionIdentityInput;
  onFirstToken?: (at: number) => void;
  backend?: RuntimeDecisionBackend;
  admission?: RuntimeInferenceProviderAdmissionCoordinator;
  deadlineAt?: number;
}): Promise<ResponseOpportunityRequestResult> {
  if (input.backend?.kind === "decisions") {
    if (!input.admission) throw new Error("Decisions RO requires shared provider admission.");
    const backend = input.backend;
    const prompts = buildResponseOpportunityPrompts(input.request, "decisions");
    const identity = createDecisionsExecutionIdentity(input.executionIdentity, {
      logicalQuestionUnitId: input.request.logicalQuestionUnitId, logicalQuestionRevision: input.request.logicalQuestionUnitRevision });
    const deadlineAt = input.deadlineAt ?? Date.now() + RESPONSE_OPPORTUNITY_GENERATION_WAIT_MS;
    const metadata: Record<string, unknown> = {};
    const result = await runDecisionProviderRequest({
      operationId: identity.requestId, admission: input.admission, lane: "critical", providerTier: "fast",
      providerConfigFingerprint: backend.providerConfigFingerprint, deadlineAt, signal: input.signal,
      onAdmitted: receipt => { metadata.responseOpportunityDecisionQueueWaitMs = receipt.waitMs;metadata.responseOpportunityDecisionProviderGroupKey = receipt.providerGroupKey; },
      execute: signal => requestDecisionsChoice({ configuration: backend.configuration, configurationError: backend.configurationError,
        question: { name: "response_opportunity", instructions: prompts.systemPrompt,
          choices: [{ value: "output-request" }, { value: "no-output-request" }, { value: "unclear" }] },
        modelInput: prompts.userMessage, executionIdentity: identity, signal, deadlineAt,
        onDispatched: at => { metadata.responseOpportunityDecisionRequestStartedAt = at; },
      }),
    });
    if (!result) return { rawOutput: "", completedAt: Date.now(), providerDisposition: "completed-empty", parseDisposition: "decisions-deadline",
      parsed: { ok: false, reason: "decisions-deadline", errorKind: "provider", targetSpansValid: false }, decisionMetadata: metadata };
    Object.assign(metadata, formatDecisionsResultForTrace(result, "responseOpportunityDecision"));
    if (!result.decision.ok) return { ...result, parsed: { ok: false, reason: result.decision.reason,
      errorKind: result.providerOutcome.status === "success" ? "schema" : "provider", targetSpansValid: false },
      parseDisposition: result.decision.reason, decisionMetadata: metadata };
    const choice = result.decision.choice as "output-request" | "no-output-request" | "unclear";
    let targetSpans: NonNullable<ReturnType<typeof resolveResponseOpportunityTargetIndexes>> = [];
    if (choice === "output-request") {
      const evidence = await requestDecisionsEvidence({ provider: input.provider, selectedProvider: input.selectedProvider,
        admission: input.admission, lane: "critical", signal: input.signal, deadlineAt, maxOutputTokens: OPERATION.maxOutputTokens,
        executionIdentity: { ...identity, requestId: `${identity.requestId}:target` }, prefix: "responseOpportunityTargetExtraction",
        systemPrompt: "The settled response decision is output-request. This decision is final. Do not classify, rescore, reverse or veto it. Select only current decisionSpans that identify the requested output and its necessary qualifiers. Include the substantive ask rather than only polite framing. Earlier boundedContext can explain the request but cannot supply target indexes. Return only a compact JSON object {\"t\":[indexes]} using unique zero-based indexes into decisionSpans in source order. Do not answer the question.",
        userMessage: JSON.stringify({ settledDecision: choice, source: JSON.parse(prompts.userMessage) }),
      });
      Object.assign(metadata, evidence.metadata);
      const parsed = evidence.response?.providerDisposition === "completed-with-content"
        ? parseRuntimeJsonObject(evidence.response.rawOutput) : undefined;
      const selected = parsed?.ok ? resolveResponseOpportunityTargetIndexes(parsed.value.t, input.request) : undefined;
      if (selected?.length) targetSpans = selected;
      metadata.responseOpportunityTargetExtractionAdopted = targetSpans.length > 0;
      metadata.responseOpportunityTargetFallback = targetSpans.length ? undefined : "existing-local-primary-ask";
    } else {
      metadata.responseOpportunityTargetExtractionRequested = false;
      metadata.responseOpportunityTargetExtractionDisposition = "decision-does-not-request-output";
    }
    return { ...result, completedAt: Date.now(), parseDisposition: "valid-decisions", decisionMetadata: metadata,
      parsed: { ok: true, targetSpansValid: true, value: { schemaVersion: 4, decision: choice, confidence: result.decision.executionScore,
        decisionProtocol: "openai-decisions", decisionTarget: targetSpans.map(span => span.text.trim()).join(" "), targetSpans,
        reason: `decisions-${choice}` } } };
  }
  const prompts = buildResponseOpportunityPrompts(input.request);
  const providerResponse = await requestRuntimeInferenceResponse({
    provider: input.provider,
    selectedProvider: input.selectedProvider,
    systemPrompt: prompts.systemPrompt,
    userMessage: prompts.userMessage,
    signal: input.signal,
    requestOptions: {
      timeoutMs: OPERATION.timeoutMs,
      maxOutputTokens: OPERATION.maxOutputTokens,
    },
    executionIdentity: {
      ...input.executionIdentity,
      logicalQuestionUnitId:
        input.executionIdentity?.logicalQuestionUnitId ??
        input.request.logicalQuestionUnitId,
      logicalQuestionRevision:
        input.executionIdentity?.logicalQuestionRevision ??
        input.request.logicalQuestionUnitRevision,
    },
    operationLabel: "Response opportunity inference",
    onFirstToken: input.onFirstToken,
  });

  const { rawOutput, providerDisposition } = providerResponse;
  const parsed =
    providerDisposition === "completed-with-content"
      ? parseResponseOpportunityOutput(rawOutput, input.request)
      : ({
          ok: false,
          reason: providerDisposition,
          errorKind: "provider",
          targetSpansValid: false,
        } satisfies ResponseOpportunityParseResult);
  return {
    ...providerResponse,
    parsed,
    parseDisposition:
      providerDisposition === "completed-with-content"
        ? parsed.ok
          ? "valid-json"
          : parsed.reason
        : `not-run-${providerDisposition}`,
  };
}
