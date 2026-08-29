export const RUNTIME_ADJUDICATION_AUTHORITY =
  "runtime-adjudication" as const;
export const RUNTIME_TYPE_ADJUDICATION_OUTPUT_ONLY_AUTHORITY =
  "runtime-type-adjudication-output-only" as const;
export const RUNTIME_TYPE_ADJUDICATION_OUTPUT_AUTHORITY_REASON =
  "runtime-type-adjudication-output-authority" as const;

export function normalizeRuntimeAdjudicationAuthorityLabel(
  value: unknown
): string | undefined {
  if (typeof value !== "string") return undefined;
  switch (value) {
    case "llm-type-repair":
      return RUNTIME_ADJUDICATION_AUTHORITY;
    case "runtime-type-repair":
    case "runtime-type-repair-output-only":
      return RUNTIME_TYPE_ADJUDICATION_OUTPUT_ONLY_AUTHORITY;
    case "runtime-type-repair-output-authority":
      return RUNTIME_TYPE_ADJUDICATION_OUTPUT_AUTHORITY_REASON;
    default:
      return value;
  }
}
