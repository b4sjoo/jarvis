import { requestRuntimeInferenceResponse } from "./runtime-inference-request.js";
import type { TYPE_PROVIDER } from "@/types";
import type {
  AIResponseExecutionIdentityInput,
  AIResponseTerminalOutcome,
} from "../functions/ai-response-events.js";
import { getRuntimeInferenceOperationDefinition, type RuntimeInferenceProviderTier } from "./runtime-inference.js";

import {
  buildTaskRelationAffinityPrompts,
  buildTaskRelationCanonicalShadowPrompts,
  hashTaskRelationSplitOutput,
  parseTaskRelationAffinityOutput,
  parseTaskRelationCanonicalShadowOutput,
  type TaskRelationAffinityParseResult,
  type TaskRelationAffinityRequest,
  type TaskRelationCanonicalShadowParseResult,
  type TaskRelationCanonicalShadowRequest,
} from "./task-relation-split-shadow.js";
import type { SelectedProviderState } from "./types.js";

export type TaskRelationSplitShadowParseResult =
  | TaskRelationAffinityParseResult
  | TaskRelationCanonicalShadowParseResult;

// Task 178 LG. Which branch of the candidate selector ended the stage. It is
// read-only: the selector passes it as an argument where it already decides,
// and nothing selects, waits or retries on it. A selected tier does not say why
// it was selected, and a parse disposition is the cached candidate's own: only
// this names a stage that ended at its deadline with an invalid candidate
// cached. A cancelled or superseded stage rejects and has no reason.
export type TaskRelationCandidateSelectionReason =
  // A parse-valid Intelligent result, "unclear" and "unknown" included.
  | "intelligent-valid"
  // Intelligent ended with an unusable result and Fast is parse-valid.
  | "intelligent-invalid-fast-valid"
  // Both candidates ended before the deadline and neither is usable.
  | "candidates-ended-unusable"
  // A candidate ended with an authentication or configuration failure.
  | "client-error"
  // The stage deadline: at entry, at the timer, at an admission granted after
  // it, or at a completion that arrived at or after it. With a selected Fast
  // tier this is the expected switch to a timely Fast candidate. It does not
  // say that a provider reported a timeout or that a request was dispatched.
  | "candidate-deadline-expired";

export interface TaskRelationSplitShadowRequestResult {
  selectedProviderTier?: RuntimeInferenceProviderTier;
  selectedCandidateCompletedAt?: number;
  stageDeadlineAt?: number;
  selectionReason?: TaskRelationCandidateSelectionReason;
  rawOutput: string;
  outputHash?: string;
  parsed: TaskRelationSplitShadowParseResult;
  providerDisposition:
    | "completed-with-content"
    | "completed-empty"
    | "provider-error-content"
    | "provider-auth-error";
  parseDisposition: string;
  providerOutcome?: Readonly<AIResponseTerminalOutcome>;
  firstTokenAt?: number;
  completedAt: number;
}

export async function requestTaskRelationSplitShadow(input: {
  request: TaskRelationAffinityRequest | TaskRelationCanonicalShadowRequest;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: SelectedProviderState;
  signal: AbortSignal;
  executionIdentity?: AIResponseExecutionIdentityInput;
  timeoutMs?: number;
  onFirstToken?: (at: number) => void;
}): Promise<TaskRelationSplitShadowRequestResult> {
  const prompts =
    input.request.operationKind === "task-relation-canonical-shadow"
      ? buildTaskRelationCanonicalShadowPrompts(input.request)
      : buildTaskRelationAffinityPrompts(input.request);
  const operation = getRuntimeInferenceOperationDefinition(
    input.request.operationKind
  );
  const providerResponse = await requestRuntimeInferenceResponse({
    provider: input.provider,
    selectedProvider: input.selectedProvider,
    systemPrompt: prompts.systemPrompt,
    userMessage: prompts.userMessage,
    signal: input.signal,
    requestOptions: {
      timeoutMs: input.timeoutMs ?? operation.timeoutMs,
      maxOutputTokens: operation.maxOutputTokens,
    },
    executionIdentity: {
      ...input.executionIdentity,
      logicalQuestionUnitId:
        input.executionIdentity?.logicalQuestionUnitId ??
        input.request.identity.logicalQuestionUnitId,
      logicalQuestionRevision:
        input.executionIdentity?.logicalQuestionRevision ??
        input.request.identity.logicalQuestionUnitRevision,
    },
    operationLabel: input.request.operationKind,
    onFirstToken: input.onFirstToken,
  });

  const { rawOutput, providerDisposition } = providerResponse;
  const parsed =
    providerDisposition === "completed-with-content"
      ? input.request.operationKind === "task-relation-canonical-shadow"
        ? parseTaskRelationCanonicalShadowOutput(rawOutput, input.request)
        : parseTaskRelationAffinityOutput(rawOutput, input.request)
      : ({
          ok: false,
          reason: providerDisposition,
          errorKind: "provider",
          evidenceSpansValid: false,
        } satisfies TaskRelationSplitShadowParseResult);
  return {
    ...providerResponse,
    parsed,
    outputHash: rawOutput
      ? hashTaskRelationSplitOutput(rawOutput)
      : undefined,
    parseDisposition:
      providerDisposition === "completed-with-content"
        ? parsed.ok
          ? "valid-json"
          : parsed.reason
        : `not-run-${providerDisposition}`,
  };
}
