import type { MeetingAnswerDisplayModel } from "./meeting-answer-display.js";
import type { StableAnswerRevision } from "./stable-answer.js";

export interface AdviseDisplayTarget {
  sessionId: string;
  suggestionId?: string;
  traceId?: string;
  generationId?: string;
  stableRevision?: number;
}

export interface AdviseDisplaySnapshot {
  target: AdviseDisplayTarget;
  sections: MeetingAnswerDisplayModel;
  stable: StableAnswerRevision | null;
  streaming: boolean;
}

export function sameAdviseDisplayTarget(
  a: AdviseDisplayTarget | undefined,
  b: AdviseDisplayTarget | undefined
) {
  return Boolean(a && b && a.sessionId === b.sessionId &&
    a.suggestionId === b.suggestionId && a.traceId === b.traceId &&
    a.generationId === b.generationId && a.stableRevision === b.stableRevision);
}

function sameGeneration(a: AdviseDisplayTarget, b: AdviseDisplayTarget) {
  return Boolean(a.generationId && a.traceId && a.sessionId === b.sessionId &&
    a.generationId === b.generationId && a.traceId === b.traceId);
}

/** One presentation pin, never a task owner, publication writer or history cache. */
export class ManualAdviseDisplay {
  private pinned: AdviseDisplaySnapshot | null = null;
  private displayed: AdviseDisplaySnapshot | null = null;
  private showCompletedUntilApplied = false;

  get locked() { return this.pinned !== null; }
  get current() { return this.displayed; }

  complete(snapshot: AdviseDisplaySnapshot) {
    if (this.pinned?.streaming && !snapshot.streaming && snapshot.stable &&
        sameGeneration(snapshot.target, this.pinned.target)) {
      this.pinned = structuredClone(snapshot);
    }
  }

  awaitingApplication(target: AdviseDisplayTarget) {
    return this.showCompletedUntilApplied && !this.displayed?.streaming &&
      target.stableRevision !== undefined && sameAdviseDisplayTarget(target, this.displayed?.target);
  }

  acknowledgeApplied(target: AdviseDisplayTarget) {
    if (this.awaitingApplication(target)) this.showCompletedUntilApplied = false;
  }

  select(current: AdviseDisplaySnapshot, latest: AdviseDisplaySnapshot | null) {
    if (this.pinned?.target.sessionId !== current.target.sessionId) this.pinned = null;
    if (this.pinned?.streaming) {
      if (latest && !latest.streaming && latest.stable && sameGeneration(latest.target, this.pinned.target)) {
        this.pinned = structuredClone(latest);
      } else if (current.streaming &&
          sameAdviseDisplayTarget(current.target, this.pinned.target)) {
        this.pinned = structuredClone(current);
      }
    }
    this.displayed = this.pinned ?? (this.showCompletedUntilApplied ? latest ?? current : current);
    return this.displayed;
  }

  toggle(expected?: AdviseDisplayTarget) {
    if (expected && !sameAdviseDisplayTarget(expected, this.displayed?.target)) {
      return { accepted: false, reason: "display-target-changed" };
    }
    if (this.pinned) {
      this.pinned = null;
      this.displayed = null;
      this.showCompletedUntilApplied = true;
      return { accepted: true, reason: "manual-unlock" };
    }
    const sections = this.displayed?.sections;
    const hasContent = sections && [sections.primaryAnswer, sections.chineseThinking, sections.focusedQuestion,
      sections.approach, sections.whiteboard, sections.code, sections.complexity, sections.clarifyingQuestion].some(value => value.trim());
    if (!this.displayed || !hasContent || (!this.displayed.stable && !this.displayed.target.generationId)) {
      return { accepted: false, reason: "no-visible-answer" };
    }
    this.pinned = structuredClone(this.displayed);
    return { accepted: true, reason: "manual-lock" };
  }

  capture(expected?: AdviseDisplayTarget) {
    if (expected && !sameAdviseDisplayTarget(expected, this.displayed?.target)) return null;
    return this.displayed ? structuredClone(this.displayed) : null;
  }

  revokeIncomplete(traceId?: string) {
    if (!traceId || !this.pinned?.streaming || this.pinned.target.traceId !== traceId) return false;
    this.pinned = null;
    this.showCompletedUntilApplied = true;
    return true;
  }

  clear() {
    this.pinned = null;
    this.displayed = null;
    this.showCompletedUntilApplied = false;
  }
}
