export type RuntimeJsonObjectParseReason =
  | "empty-output"
  | "output-too-large"
  | "truncated-json"
  | "malformed-json"
  | "output-is-not-object";

export type RuntimeJsonObjectParseResult =
  | {
      ok: true;
      value: Record<string, unknown>;
      normalizedOutput: string;
      fenceStripped: boolean;
    }
  | {
      ok: false;
      reason: RuntimeJsonObjectParseReason;
      errorKind: "parse" | "schema";
      normalizedOutput: string;
      fenceStripped: boolean;
    };

export function parseRuntimeJsonObject(
  rawOutput: string,
  options: { maxChars?: number } = {}
): RuntimeJsonObjectParseResult {
  const envelope = normalizeRuntimeJsonEnvelope(rawOutput);
  const value = envelope.value;
  if (!value) {
    return failure("empty-output", "parse", envelope);
  }
  if (options.maxChars !== undefined && value.length > options.maxChars) {
    return failure("output-too-large", "parse", envelope);
  }
  if (envelope.unclosedFence) {
    return failure("truncated-json", "parse", envelope);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return failure(
      looksLikeTruncatedJsonObject(value)
        ? "truncated-json"
        : "malformed-json",
      "parse",
      envelope
    );
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return failure("output-is-not-object", "schema", envelope);
  }
  return {
    ok: true,
    value: decoded as Record<string, unknown>,
    normalizedOutput: value,
    fenceStripped: envelope.fenceStripped,
  };
}

export function isRuntimeJsonObjectTruncated(rawOutput: string) {
  const result = parseRuntimeJsonObject(rawOutput);
  return !result.ok && result.reason === "truncated-json";
}

function normalizeRuntimeJsonEnvelope(rawOutput: string) {
  const trimmed = rawOutput.replace(/^\uFEFF/u, "").trim();
  if (!trimmed.startsWith("```")) {
    return {
      value: trimmed,
      fenceStripped: false,
      unclosedFence: false,
    };
  }
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  if (fenced) {
    return {
      value: fenced[1]?.trim() ?? "",
      fenceStripped: true,
      unclosedFence: false,
    };
  }
  return {
    value: trimmed,
    fenceStripped: false,
    unclosedFence: !trimmed.endsWith("```"),
  };
}

function looksLikeTruncatedJsonObject(value: string) {
  if (!value.startsWith("{")) return false;
  if (value.endsWith("}")) return false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return inString || depth > 0;
}

function failure(
  reason: RuntimeJsonObjectParseReason,
  errorKind: "parse" | "schema",
  envelope: {
    value: string;
    fenceStripped: boolean;
  }
): RuntimeJsonObjectParseResult {
  return {
    ok: false,
    reason,
    errorKind,
    normalizedOutput: envelope.value,
    fenceStripped: envelope.fenceStripped,
  };
}
