import { DECISIONS_PROVIDER_ID } from "../../config/decisions.constants.js";
import type { AIResponseExecutionIdentityInput } from "../functions/ai-response-events.js";
import { requestDecisionsChoice, formatDecisionsResultForTrace } from "./decisions-request.js";
import { createDecisionsExecutionIdentity, type RuntimeDecisionBackend } from "./decisions-runtime.js";
import { runDecisionProviderRequest } from "./decision-provider-request.js";
import { requestDecisionsEvidence } from "./decisions-evidence-request.js";
import { parseRuntimeJsonObject } from "./runtime-json-object.js";
import { getRuntimeInferenceOperationDefinition, type RuntimeInferenceLane } from "./runtime-inference.js";
import type { RuntimeInferenceProviderAdmissionCoordinator } from "./runtime-inference-provider-admission.js";
import type { RuntimeInferenceModelRouteResolution } from "./meeting-model-route.js";
import { RUNTIME_TASK_RELATIONS, type RuntimeTaskRelation } from "./task-relation-adjudication.js";
import {
  buildTaskRelationAffinityPrompts, buildTaskRelationCanonicalShadowPrompts, hashTaskRelationSplitOutput,
  parseTaskRelationAffinityOutput, type TaskRelationAffinityRequest, type TaskRelationCanonicalShadowRequest,
  type TaskRelationAffinityAdjudication,
} from "./task-relation-split-shadow.js";
import type { TaskRelationSplitShadowRequestResult } from "./task-relation-split-shadow-request.js";
import type { TaskRelationCandidateObservation } from "./task-relation-provider-candidates.js";

export async function requestTaskRelationDecisions(input: {
  request: TaskRelationAffinityRequest | TaskRelationCanonicalShadowRequest;
  backend: Extract<RuntimeDecisionBackend, { kind: "decisions" }>;
  operationId: string; executionIdentity: AIResponseExecutionIdentityInput;
  fastRoute: RuntimeInferenceModelRouteResolution;
  admission: RuntimeInferenceProviderAdmissionCoordinator; lane: RuntimeInferenceLane;
  signal: AbortSignal; deadlineAt: number;
  onObservation?: (event: TaskRelationCandidateObservation) => void;
  onRequest?: (requestId: string, providerTier: "intelligent" | "fast", at: number) => void;
}): Promise<TaskRelationSplitShadowRequestResult> {
  const { request, backend } = input;
  const canonical = request.operationKind === "task-relation-canonical-shadow";
  const prefix = canonical ? "taskRelationSplitCanonical" : request.affinityKind === "child" ? "taskRelationChildAffinity" : "taskRelationParentAffinity";
  const evidencePrefix = `${prefix}DecisionEvidence`;
  const prompts = canonical ? buildTaskRelationCanonicalShadowPrompts(request, "decisions") : buildTaskRelationAffinityPrompts(request, "decisions");
  const choices = canonical ? [...RUNTIME_TASK_RELATIONS]
    : request.affinityKind === "child" ? ["related", "unrelated", "unclear"] : ["related", "independent", "unclear"];
  const identity = createDecisionsExecutionIdentity({ ...input.executionIdentity, requestId: `${input.operationId}:decision` }, {
    logicalQuestionUnitId: request.identity.logicalQuestionUnitId, logicalQuestionRevision: request.identity.logicalQuestionUnitRevision });
  const queuedAt = Date.now();
  // The existing tier identifies the logical decision role, not the physical
  // provider. Fast below is evidence-only and can never be selected as a vote.
  const coreEvent = { operationId: input.operationId, requestId: identity.requestId, providerTier: "intelligent" as const,
    providerId: DECISIONS_PROVIDER_ID, configFingerprint: backend.providerConfigFingerprint,
    role: "decision" as const, deadlineAt: input.deadlineAt, queuedAt };
  const observe = (event: TaskRelationCandidateObservation) => { try { input.onObservation?.(event); } catch { /* Observation cannot veto a decision. */ } };
  const started = (requestId: string, tier: "intelligent" | "fast", at: number) => { try { input.onRequest?.(requestId, tier, at); } catch { /* Same observational boundary. */ } };
  const unavailable = (reason: string): TaskRelationSplitShadowRequestResult => ({ rawOutput: "", parsed: {
    ok: false, reason, errorKind: "provider", evidenceSpansValid: false }, providerDisposition: "completed-empty",
    parseDisposition: reason, completedAt: Date.now(), stageDeadlineAt: input.deadlineAt, selectionReason: "candidate-deadline-expired" });
  observe({ ...coreEvent, event: "queued", at: queuedAt });
  let core;
  try {
    core = await runDecisionProviderRequest({ operationId: identity.requestId, admission: input.admission,
      providerConfigFingerprint: backend.providerConfigFingerprint, providerTier: "intelligent", lane: input.lane,
      deadlineAt: input.deadlineAt, signal: input.signal,
      onAdmitted: admission => observe({ ...coreEvent, event: "admitted", at: admission.admittedAt, admission }),
      execute: signal => requestDecisionsChoice({ configuration: backend.configuration, configurationError: backend.configurationError,
        question: { name: canonical ? "canonical_relation" : "affinity", instructions: prompts.systemPrompt, choices: choices.map(value => ({ value })) },
        modelInput: prompts.userMessage, executionIdentity: identity, signal, deadlineAt: input.deadlineAt,
        onDispatched: at => started(identity.requestId, "intelligent", at) }),
    });
  } catch (error) {
    observe({ ...coreEvent, event: "cancelled", at: Date.now(), error: "source-cancelled-or-request-failed" });throw error;
  }
  if (!core) {
    observe({ ...coreEvent, event: "cancelled", at: Date.now(), error: "stage-deadline" });
    return unavailable("decisions-deadline");
  }
  const decisionMetadata = formatDecisionsResultForTrace(core, `${prefix}Decision`);
  const base = { ...core, stageDeadlineAt: input.deadlineAt, decisionMetadata,
    outputHash: core.rawOutput ? hashTaskRelationSplitOutput(core.rawOutput) : undefined };
  if (!core.decision.ok) {
    const result: TaskRelationSplitShadowRequestResult = { ...base, parsed: { ok: false, reason: core.decision.reason,
      errorKind: core.providerOutcome.status === "success" ? "schema" : "provider", evidenceSpansValid: false },
      parseDisposition: core.decision.reason, selectionReason: ["authentication", "configuration"].includes(core.providerOutcome.failureClass ?? "")
        ? "client-error" : "decisions-unusable" };
    observe({ ...coreEvent, event: "completed", at: Date.now(), result });return result;
  }
  const known = { confidence: core.decision.executionScore, currentEvidenceSpans: [] as string[], branchEvidenceSpans: [] as string[] };
  let result: TaskRelationSplitShadowRequestResult = { ...base, selectedProviderTier: "intelligent", selectedCandidateCompletedAt: core.completedAt,
    selectionReason: "decisions-valid", parseDisposition: "valid-decisions", parsed: canonical
      ? { ok: true, evidenceSpansValid: true, value: { schemaVersion: 3, relation: core.decision.choice as RuntimeTaskRelation,
          confidence: known.confidence, currentQuestionEvidenceSpans: [], parentEvidenceSpans: [] } }
      : { ok: true, evidenceSpansValid: true, value: { schemaVersion: 1, affinityKind: request.affinityKind,
          decision: core.decision.choice as TaskRelationAffinityAdjudication["decision"], ...known } } };
  observe({ ...coreEvent, event: "completed", at: core.completedAt, result: { ...result, decisionMetadata: { ...decisionMetadata } } });
  if (!canonical && core.decision.choice !== "unclear") {
    const requestId = `${input.operationId}:evidence`;
    const event = { ...coreEvent, requestId, providerTier: "fast" as const, providerId: input.fastRoute.resolvedProviderId,
      configFingerprint: input.fastRoute.configFingerprint, role: "evidence" as const, queuedAt: Date.now() };
    if (input.fastRoute.provider && Date.now() < input.deadlineAt) observe({ ...event, event: "queued", at: event.queuedAt });
    try {
      const evidence = await requestDecisionsEvidence({ provider: input.fastRoute.provider, selectedProvider: input.fastRoute.selectedProvider,
        admission: input.admission, lane: input.lane, signal: input.signal, deadlineAt: input.deadlineAt,
        maxOutputTokens: getRuntimeInferenceOperationDefinition(request.operationKind).maxOutputTokens,
        executionIdentity: { ...identity, requestId }, prefix: evidencePrefix,
        onRequest: at => started(requestId, "fast", at),
        onAdmitted: admission => observe({ ...event, event: "admitted", at: admission.admittedAt, admission }),
        systemPrompt: "The supplied settledDecision is final. Do not classify, change, rescore or veto it. Extract supporting evidence only. Return a compact JSON object with q and b. q is one exact currentQuestion.sourceTexts substring, at most 180 characters. For related, b is one exact active branch or its recent source evidence substring, at most 180 characters. For independent or unrelated, b is null. If a quote is unavailable, use null. Do not answer the interview question or return decision/confidence fields.",
        userMessage: JSON.stringify({ settledDecision: core.decision.choice, source: request.semanticPayload }),
      });
      Object.assign(decisionMetadata, evidence.metadata);
      const parsed = evidence.response?.providerDisposition === "completed-with-content" ? parseRuntimeJsonObject(evidence.response.rawOutput) : undefined;
      // Reuse the strict source-quote validator with the frozen core fields.
      // Only its quote arrays are adopted, never a Fast decision or score.
      const quotes = parsed?.ok ? parseTaskRelationAffinityOutput(JSON.stringify({ v: 1,
        d: core.decision.choice === "related" ? "r" : core.decision.choice === "unrelated" ? "n" : "i",
        c: known.confidence, q: parsed.value.q, b: parsed.value.b }), request) : undefined;
      if (quotes?.ok) {
        known.currentEvidenceSpans = quotes.value.currentEvidenceSpans;
        known.branchEvidenceSpans = quotes.value.branchEvidenceSpans;
      }
      decisionMetadata[`${evidencePrefix}Adopted`] = quotes?.ok === true;
      if (evidence.metadata[`${evidencePrefix}Requested`]) observe({ ...event,
        event: evidence.response ? "completed" : "cancelled", at: Date.now(), evidenceResponse: evidence.response });
      result = { ...result, decisionMetadata, parsed: { ok: true, evidenceSpansValid: true, value: {
        schemaVersion: 1, affinityKind: request.affinityKind, decision: core.decision.choice as TaskRelationAffinityAdjudication["decision"], ...known,
      } } };
    } catch (error) {
      observe({ ...event, event: "cancelled", at: Date.now(), error: "source-cancelled" });throw error;
    }
  } else {
    decisionMetadata[`${evidencePrefix}Requested`] = false;
    decisionMetadata[`${evidencePrefix}Disposition`] = canonical ? "canonical-trace-only-not-requested" : "semantic-unclear";
  }
  input.signal.throwIfAborted();
  observe({ ...coreEvent, event: "selected", at: Date.now(), result });
  return { ...result, completedAt: Date.now() };
}
