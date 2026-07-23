import {
  parseTaxonomyAdjudicationOutput,
  type TaxonomyAdjudicationParseResult,
  type TaxonomyAdjudicationRequest,
} from "./taxonomy-adjudication.js";

export interface TaxonomyAdjudicationRequestResult {
  rawOutput: string;
  parsed: TaxonomyAdjudicationParseResult;
  providerDisposition:
    | "completed-with-content"
    | "completed-empty"
    | "provider-error-content"
    | "provider-auth-error";
  parseDisposition: string;
  firstTokenAt?: number;
  completedAt: number;
}

export async function consumeTaxonomyAdjudicationResponse(input: {
  request: TaxonomyAdjudicationRequest;
  responseStream: AsyncIterable<string>;
  signal: AbortSignal;
  onFirstToken?: (at: number) => void;
}): Promise<TaxonomyAdjudicationRequestResult> {
  let rawOutput = "";
  let firstTokenAt: number | undefined;
  for await (const chunk of input.responseStream) {
    if (input.signal.aborted) break;
    if (firstTokenAt === undefined && chunk) {
      firstTokenAt = Date.now();
      input.onFirstToken?.(firstTokenAt);
    }
    rawOutput += chunk;
  }
  if (input.signal.aborted) {
    throw new DOMException("Taxonomy adjudication aborted", "AbortError");
  }
  const providerDisposition =
    classifyTaxonomyAdjudicationProviderOutput(rawOutput);
  const parsed =
    providerDisposition === "provider-auth-error"
      ? {
          ok: false as const,
          reason: "provider-auth-error",
          evidenceSpansValid: false,
        }
      : parseTaxonomyAdjudicationOutput(rawOutput, input.request);
  return {
    rawOutput,
    parsed,
    providerDisposition,
    parseDisposition:
      providerDisposition === "provider-auth-error"
        ? "not-run-provider-auth-error"
        : parsed.ok
          ? "valid-json"
          : parsed.reason,
    firstTokenAt,
    completedAt: Date.now(),
  };
}

export function classifyTaxonomyAdjudicationProviderOutput(
  rawOutput: string
): TaxonomyAdjudicationRequestResult["providerDisposition"] {
  const trimmed = rawOutput.trim();
  if (!trimmed) return "completed-empty";
  if (
    /\b(?:401|403|unauthenticated|unauthorized|forbidden|invalid api key|valid api key|api key not valid|authentication failed|invalid credential|permission denied)\b/iu.test(
      trimmed
    )
  ) {
    return "provider-auth-error";
  }
  if (
    /^(?:API request failed:|Network error during API request:|Failed to parse non-streaming response:|Streaming not supported or response body missing|Failed to parse response:)/iu.test(
      trimmed
    )
  ) {
    return "provider-error-content";
  }
  return "completed-with-content";
}
