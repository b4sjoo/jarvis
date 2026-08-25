import type { InterviewPlaybookPhase } from "./types.js";

export const CODING_SOLUTION_MANIFEST_VERSION = 1;
export const CODING_SOLUTION_MANIFEST_MAX_CHARS = 1_200;
export const CODING_SOLUTION_MANIFEST_TAG = "CODING_SOLUTION_MANIFEST";

export interface CodingSolutionCandidateSummary {
  approach: string;
  dataStructures: string[];
  time: string;
  space: string;
}

export interface CodingSolutionManifest {
  version: 1;
  baseline: CodingSolutionCandidateSummary;
  optimized: CodingSolutionCandidateSummary;
  sameSolution: boolean;
  reason: string;
  visibleCandidate: "baseline" | "optimized";
}

export interface CodingSolutionManifestExtraction {
  displayContent: string;
  manifest?: CodingSolutionManifest;
  disposition:
    | "parsed"
    | "missing"
    | "too-large"
    | "invalid-json"
    | "invalid-schema";
}

export interface CodingSolutionManifestPhaseDecision {
  authorized: boolean;
  reason:
    | "authorized"
    | "manifest-missing-or-invalid"
    | "manifest-candidates-inconsistent"
    | "optimized-fallback-authorized"
    | "baseline-visible-candidate-mismatch"
    | "optimized-visible-candidate-mismatch";
  phase: "baseline_reasoning" | "optimized_pseudocode" | "implementation_validation";
  expectedVisibleCandidate: "baseline" | "optimized";
  actualVisibleCandidate?: "baseline" | "optimized";
  codeMutationAuthorized: boolean;
}

export function extractCodingSolutionManifest(
  content: string
): CodingSolutionManifestExtraction {
  const pattern = new RegExp(
    `<${CODING_SOLUTION_MANIFEST_TAG}>([\\s\\S]*?)<\\/${CODING_SOLUTION_MANIFEST_TAG}>\\s*$`,
    "i"
  );
  const match = content.match(pattern);
  if (!match) {
    return { displayContent: content.trim(), disposition: "missing" };
  }
  const displayContent = content.slice(0, match.index).trim();
  const raw = match[1].trim();
  if (raw.length > CODING_SOLUTION_MANIFEST_MAX_CHARS) {
    return { displayContent, disposition: "too-large" };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { displayContent, disposition: "invalid-json" };
  }
  const manifest = parseManifest(decoded);
  return manifest
    ? { displayContent, manifest, disposition: "parsed" }
    : { displayContent, disposition: "invalid-schema" };
}

export function validateCodingSolutionManifestPhase(input: {
  phase: InterviewPlaybookPhase | undefined;
  extraction: CodingSolutionManifestExtraction;
}): CodingSolutionManifestPhaseDecision {
  const phase = normalizeCodingPhase(input.phase);
  const expectedVisibleCandidate =
    phase === "baseline_reasoning" ? "baseline" : "optimized";
  const actualVisibleCandidate = input.extraction.manifest?.visibleCandidate;
  if (!input.extraction.manifest) {
    return {
      authorized: false,
      reason: "manifest-missing-or-invalid",
      phase,
      expectedVisibleCandidate,
      actualVisibleCandidate,
      codeMutationAuthorized: false,
    };
  }
  if (!manifestCandidatesAreCoherent(input.extraction.manifest)) {
    return {
      authorized: false,
      reason: "manifest-candidates-inconsistent",
      phase,
      expectedVisibleCandidate,
      actualVisibleCandidate,
      codeMutationAuthorized: false,
    };
  }
  if (
    phase === "baseline_reasoning" &&
    actualVisibleCandidate === "optimized"
  ) {
    return {
      authorized: true,
      reason: "optimized-fallback-authorized",
      phase,
      expectedVisibleCandidate,
      actualVisibleCandidate,
      codeMutationAuthorized: true,
    };
  }
  if (actualVisibleCandidate !== expectedVisibleCandidate) {
    return {
      authorized: false,
      reason:
        phase === "baseline_reasoning"
          ? "baseline-visible-candidate-mismatch"
          : "optimized-visible-candidate-mismatch",
      phase,
      expectedVisibleCandidate,
      actualVisibleCandidate,
      codeMutationAuthorized: false,
    };
  }
  return {
    authorized: true,
    reason: "authorized",
    phase,
    expectedVisibleCandidate,
    actualVisibleCandidate,
    codeMutationAuthorized:
      phase === "baseline_reasoning" ||
      phase === "implementation_validation",
  };
}

function manifestCandidatesAreCoherent(manifest: CodingSolutionManifest) {
  const baseline = manifest.baseline;
  const optimized = manifest.optimized;
  const sameComplexityAndStructures =
    normalizeCandidateField(baseline.time) ===
      normalizeCandidateField(optimized.time) &&
    normalizeCandidateField(baseline.space) ===
      normalizeCandidateField(optimized.space) &&
    normalizeCandidateList(baseline.dataStructures) ===
      normalizeCandidateList(optimized.dataStructures);
  const sameSummary =
    sameComplexityAndStructures &&
    normalizeCandidateField(baseline.approach) ===
      normalizeCandidateField(optimized.approach);
  return manifest.sameSolution
    ? sameComplexityAndStructures
    : !sameSummary;
}

function normalizeCandidateField(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeCandidateList(values: string[]) {
  return values.map(normalizeCandidateField).sort().join("|");
}

export function formatCodingSolutionManifestForPrompt(
  manifest: CodingSolutionManifest | undefined
) {
  if (!manifest) return "No cached Coding solution manifest.";
  return JSON.stringify({
    baseline: manifest.baseline,
    optimized: manifest.optimized,
    sameSolution: manifest.sameSolution,
    reason: manifest.reason,
  });
}

export function formatCodingSolutionManifestForTrace(input: {
  extraction?: CodingSolutionManifestExtraction;
  phaseDecision?: CodingSolutionManifestPhaseDecision;
  cacheHit?: boolean;
}) {
  return {
    codingSolutionManifestDisposition: input.extraction?.disposition,
    codingSolutionManifestParsed: Boolean(input.extraction?.manifest),
    codingSolutionManifestSameSolution:
      input.extraction?.manifest?.sameSolution,
    codingSolutionManifestVisibleCandidate:
      input.extraction?.manifest?.visibleCandidate,
    codingSolutionManifestPhaseAuthorized:
      input.phaseDecision?.authorized,
    codingSolutionManifestPhaseReason: input.phaseDecision?.reason,
    codingSolutionManifestExpectedVisibleCandidate:
      input.phaseDecision?.expectedVisibleCandidate,
    codingSolutionManifestCodeMutationAuthorized:
      input.phaseDecision?.codeMutationAuthorized,
    codingSolutionManifestCacheHit: input.cacheHit ?? false,
  };
}

function parseManifest(value: unknown): CodingSolutionManifest | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.version !== CODING_SOLUTION_MANIFEST_VERSION ||
    typeof value.sameSolution !== "boolean" ||
    typeof value.reason !== "string" ||
    value.reason.trim().length === 0 ||
    value.reason.length > 160 ||
    (value.visibleCandidate !== "baseline" &&
      value.visibleCandidate !== "optimized")
  ) {
    return undefined;
  }
  const baseline = parseCandidate(value.baseline);
  const optimized = parseCandidate(value.optimized);
  if (!baseline || !optimized) return undefined;
  return {
    version: 1,
    baseline,
    optimized,
    sameSolution: value.sameSolution,
    reason: value.reason.trim(),
    visibleCandidate: value.visibleCandidate,
  };
}

function parseCandidate(value: unknown): CodingSolutionCandidateSummary | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.approach !== "string" ||
    typeof value.time !== "string" ||
    typeof value.space !== "string" ||
    !Array.isArray(value.dataStructures) ||
    value.dataStructures.length > 6 ||
    !value.dataStructures.every(
      (item) => typeof item === "string" && item.trim().length <= 80
    )
  ) {
    return undefined;
  }
  const approach = value.approach.trim();
  const time = value.time.trim();
  const space = value.space.trim();
  if (!approach || approach.length > 240 || !time || !space) return undefined;
  return {
    approach,
    dataStructures: value.dataStructures.map((item) => item.trim()),
    time: time.slice(0, 80),
    space: space.slice(0, 80),
  };
}

function normalizeCodingPhase(
  phase: InterviewPlaybookPhase | undefined
): CodingSolutionManifestPhaseDecision["phase"] {
  if (phase === "optimized_pseudocode") return phase;
  if (phase === "implementation_validation") return phase;
  return "baseline_reasoning";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
