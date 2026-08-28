export const TERM_CORRECTION_PROJECTION_MAX_CHARS = 1_200;

export interface TermCorrectionProjectionDescriptor {
  normalizedTerm: string;
  sourceTerm?: string;
  replacedText?: string;
}

export function applyTermCorrectionOverlaysToText(
  text: string,
  overlays: TermCorrectionProjectionDescriptor[]
) {
  return overlays.reduce(
    (current, overlay) => applyTermCorrectionOverlayToText(current, overlay),
    removeTermCorrectionAnnotations(text)
  );
}

export function applyTermCorrectionOverlayToText(
  text: string,
  overlay: TermCorrectionProjectionDescriptor
) {
  const normalizedTerm = overlay.normalizedTerm.trim();
  if (!normalizedTerm) return text.trim();
  const sourceTerm = (overlay.sourceTerm ?? overlay.replacedText)?.trim();
  const correctedText = sourceTerm
    ? replacePhrase(text, sourceTerm, normalizedTerm)
    : text;
  const annotation = `[Manual term correction applied: the intended term is "${normalizedTerm}".]`;
  const availableTextChars = Math.max(
    0,
    TERM_CORRECTION_PROJECTION_MAX_CHARS - annotation.length - 1
  );
  const boundedText =
    correctedText.length <= availableTextChars
      ? correctedText.trim()
      : correctedText.slice(0, availableTextChars).trimEnd();
  return [boundedText, annotation].filter(Boolean).join("\n");
}

export function removeTermCorrectionAnnotations(text: string) {
  return text
    .replace(
      /\n?\[Manual term correction(?: applied)?:[^\]]*\]\.?/gi,
      ""
    )
    .trim();
}

export function applySpeechCorrectionReplacement(input: {
  text: string;
  from?: string;
  to?: string;
}) {
  const from = input.from?.trim();
  const to = input.to?.trim();
  return from && to ? replacePhrase(input.text, from, to) : input.text;
}

function replacePhrase(text: string, from: string, to: string) {
  return text.replace(new RegExp(escapeRegExp(from), "gi"), to);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
