import type { ArtifactRegenerationTarget } from "./artifact-regeneration.js";
import type { StableAnswerRevision, ArtifactOnlyAnswerSection } from "./stable-answer.js";
import type { ParsedMeetingAnswer, MeetingAssistantSettings } from "./types.js";
import { equalTaskRuntimeValues } from "./active-meeting-task.js";

// One bounded payload. Oversized incidental output is a miss, never truncated code.
export const MAX_UNPUBLISHED_ARTIFACT_CHARS = 24_000;
export interface ArtifactReuseInputs {
  manualCorrectionRevision: number;
  preparationContextRevision: number;
  screenHash?: string;
  latestTurnId?: string;
  latestObservationId?: string;
  settings: MeetingAssistantSettings;
}
export interface UnpublishedArtifactOffer {
  parsed: ParsedMeetingAnswer;
  authorizedArtifacts: readonly string[];
  inputs: ArtifactReuseInputs;
}
export interface UnpublishedArtifactCandidate {
  suggestionId: string;
  traceId?: string;
  target: ArtifactRegenerationTarget;
  base: Record<ArtifactOnlyAnswerSection, number>;
  inputs: ArtifactReuseInputs;
  sections: Partial<Record<ArtifactOnlyAnswerSection, string>>;
}

/** Only an accepted publication installs a candidate; no asynchronous cleanup owns the slot. */
export class UnpublishedArtifactSlot {
  private candidate: UnpublishedArtifactCandidate | null = null;
  clear() { this.candidate = null; }
  get present() { return this.candidate !== null; }

  accepted(input: {
    stable: StableAnswerRevision;
    current: StableAnswerRevision | null;
    target?: ArtifactRegenerationTarget;
    offer?: UnpublishedArtifactOffer;
    currentInputs: ArtifactReuseInputs;
  }) {
    if (input.current !== input.stable) return;
    this.clear();
    const { stable, target, offer } = input;
    if (!target || !offer || !equalTaskRuntimeValues(offer.inputs, input.currentInputs)) return;
    if (offer.parsed.parseStatus === "partial" || offer.parsed.parseStatus === "empty") return;
    const sections: UnpublishedArtifactCandidate["sections"] = {};
    const nonempty = (text?: string) => Boolean(text?.trim() && text.trim() !== "-");
    if (!offer.authorizedArtifacts.includes("code") && !offer.authorizedArtifacts.includes("complexity") &&
        nonempty(offer.parsed.sections.code) && nonempty(offer.parsed.sections.complexity)) {
      sections.code = offer.parsed.sections.code;
      sections.complexity = offer.parsed.sections.complexity;
    }
    if (!offer.authorizedArtifacts.includes("whiteboard") && nonempty(offer.parsed.sections.whiteboard)) {
      sections.whiteboard = offer.parsed.sections.whiteboard;
    }
    if (!target.artifactFamilies.every((family) => sections[family]) ||
        Object.values(sections).reduce((n, value) => n + value.length, 0) > MAX_UNPUBLISHED_ARTIFACT_CHARS) return;
    this.candidate = structuredClone({
      suggestionId: stable.suggestion.id, traceId: stable.suggestion.sourceTraceId,
      target, inputs: offer.inputs, sections,
      base: { code: stable.sections.code.revision, complexity: stable.sections.complexity.revision,
        whiteboard: stable.sections.whiteboard.revision },
    });
  }

  take(input: { target: ArtifactRegenerationTarget; stable: StableAnswerRevision | null; inputs: ArtifactReuseInputs }) {
    const candidate = this.candidate;
    if (!candidate) return { reason: "candidate-missing" };
    if (!input.stable || candidate.suggestionId !== input.stable.suggestion.id) return { reason: "generation-mismatch" };
    if (!equalTaskRuntimeValues(candidate.target, input.target)) return { reason: "target-mismatch" };
    if (!equalTaskRuntimeValues(candidate.inputs, input.inputs)) return { reason: "inputs-changed" };
    if (input.target.artifactFamilies.some((family) => candidate.base[family] !== input.stable!.sections[family].revision)) {
      return { reason: "artifact-base-changed" };
    }
    // Reserve synchronously before any async render validation or generation begins.
    this.clear();
    if (input.target.artifactFamilies.every((family) =>
      candidate.sections[family]?.trim() === input.stable!.suggestion.meetingAnswer?.sections[family]?.trim())) {
      return { reason: "no-change" };
    }
    return { reason: "matched", candidate };
  }
}
