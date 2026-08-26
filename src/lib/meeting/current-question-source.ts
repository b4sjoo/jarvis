export type CurrentQuestionSourceKind = "voice" | "screen" | "mixed";

export function resolveCurrentQuestionSourceKind(input: {
  sourceTurnIds?: readonly string[];
  sourceObservationIds?: readonly string[];
  fallback: CurrentQuestionSourceKind;
}): CurrentQuestionSourceKind {
  const hasVoice = (input.sourceTurnIds?.length ?? 0) > 0;
  const hasScreen = (input.sourceObservationIds?.length ?? 0) > 0;
  if (hasVoice && hasScreen) return "mixed";
  if (hasScreen) return "screen";
  if (hasVoice) return "voice";
  return input.fallback;
}
