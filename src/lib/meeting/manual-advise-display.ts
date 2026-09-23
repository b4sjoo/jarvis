import type { MeetingAnswerDisplayModel } from "./meeting-answer-display.js";
import type { StableAnswerRevision } from "./stable-answer.js";

export interface AdviseDisplayTarget {
  sessionId: string;
  // Empty or legacy pending displays may lack identity; they cannot be locked.
  logicalQuestionUnitId?: string;
  logicalQuestionRevision?: number;
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
    a.logicalQuestionUnitId === b.logicalQuestionUnitId &&
    a.logicalQuestionRevision === b.logicalQuestionRevision &&
    a.suggestionId === b.suggestionId && a.traceId === b.traceId &&
    a.generationId === b.generationId && a.stableRevision === b.stableRevision);
}

function sameGeneration(a: AdviseDisplayTarget, b: AdviseDisplayTarget) {
  return Boolean(a.generationId && a.traceId && a.sessionId === b.sessionId &&
    a.logicalQuestionUnitId === b.logicalQuestionUnitId &&
    a.logicalQuestionRevision === b.logicalQuestionRevision &&
    a.generationId === b.generationId && a.traceId === b.traceId);
}

function hasLogicalQuestion(target: AdviseDisplayTarget) {
  return Boolean(target.logicalQuestionUnitId?.trim() &&
    Number.isSafeInteger(target.logicalQuestionRevision) && target.logicalQuestionRevision! >= 0);
}

function hasConsistentStable(snapshot: AdviseDisplaySnapshot) {
  const { stable, target } = snapshot;
  return Boolean(!snapshot.streaming && stable && hasLogicalQuestion(target) &&
    (!stable.sessionId || stable.sessionId === target.sessionId) &&
    stable.logicalQuestionUnitId === target.logicalQuestionUnitId &&
    stable.logicalQuestionRevision === target.logicalQuestionRevision &&
    stable.revision === target.stableRevision);
}

// Display DTOs contain only scalar values, arrays and plain objects.
function sameDisplayValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((value, index) => sameDisplayValue(value, b[index]));
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && sameDisplayValue(left[key], right[key]));
}

function sameDisplaySnapshot(a: AdviseDisplaySnapshot | null, b: AdviseDisplaySnapshot) {
  if (!a || !sameAdviseDisplayTarget(a.target, b.target) ||
      a.streaming !== b.streaming || a.stable !== b.stable) return false;
  const { parsedAnswer: parsedA, ...sectionsA } = a.sections;
  const { parsedAnswer: parsedB, ...sectionsB } = b.sections;
  // The Hook may reparse the same stream on a recorder render. Time is not display content.
  const { parsedAt: _timeA, ...contentA } = parsedA;
  const { parsedAt: _timeB, ...contentB } = parsedB;
  return sameDisplayValue(sectionsA, sectionsB) && sameDisplayValue(contentA, contentB);
}

function freezeDisplayCopy<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDisplayCopy);
    Object.freeze(value);
  }
  return value;
}

function copyDisplaySnapshot(snapshot: AdviseDisplaySnapshot): AdviseDisplaySnapshot {
  // Stable is already owned immutably by the publisher; freeze only our detached display copy.
  return Object.freeze({ ...snapshot, target: Object.freeze({ ...snapshot.target }),
    sections: freezeDisplayCopy(structuredClone(snapshot.sections)) });
}

/** One LQU selection with its last completion/preview; latest stays with the caller. */
export class ManualAdviseDisplay {
  private selection: AdviseDisplayTarget | null = null;
  private pinned: AdviseDisplaySnapshot | null = null;
  private completed: AdviseDisplaySnapshot | null = null;
  private displayed: AdviseDisplaySnapshot | null = null;
  private showCompletedUntilApplied = false;

  get locked() { return this.selection !== null; }
  get current() { return this.displayed; }

  // Selection reads do not confer source or lease authority.
  get selectedTarget(): Readonly<AdviseDisplayTarget> | null {
    return this.selection ? { ...this.selection } : null;
  }

  get selectedStable(): Readonly<StableAnswerRevision> | null {
    // The publication owner provides this immutable object; preserve its identity.
    return this.completed?.stable ?? null;
  }

  private accepts(target: AdviseDisplayTarget) {
    return Boolean(this.selection && hasLogicalQuestion(target) &&
      target.sessionId === this.selection.sessionId &&
      target.logicalQuestionUnitId === this.selection.logicalQuestionUnitId &&
      target.logicalQuestionRevision! >= this.selection.logicalQuestionRevision!);
  }

  /** The caller validates generation/source/lease freshness before offering a result. */
  complete(snapshot: AdviseDisplaySnapshot) {
    if (!this.accepts(snapshot.target) || !hasConsistentStable(snapshot)) return;
    if (this.completed && this.completed.target.logicalQuestionRevision === snapshot.target.logicalQuestionRevision &&
        this.completed.stable!.revision >= snapshot.stable!.revision) return;
    this.selection = { ...snapshot.target };
    this.completed = this.pinned = copyDisplaySnapshot(snapshot);
  }

  awaitingApplication(target: AdviseDisplayTarget) {
    return this.showCompletedUntilApplied && !this.displayed?.streaming &&
      target.stableRevision !== undefined && sameAdviseDisplayTarget(target, this.displayed?.target);
  }

  acknowledgeApplied(target: AdviseDisplayTarget) {
    if (this.awaitingApplication(target)) this.showCompletedUntilApplied = false;
  }

  select(current: AdviseDisplaySnapshot, latest: AdviseDisplaySnapshot | null) {
    const previousSession = this.selection?.sessionId ?? this.displayed?.target.sessionId;
    if (previousSession && previousSession !== current.target.sessionId) this.clear();
    const latestInSession = latest?.target.sessionId === current.target.sessionId ? latest : null;
    if (this.selection) {
      this.complete(current);
      if (latestInSession) this.complete(latestInSession);
      if (current.streaming && current.target.generationId && this.accepts(current.target) &&
          !(this.completed && sameGeneration(current.target, this.completed.target))) {
        if (!sameDisplaySnapshot(this.pinned, current)) {
          this.selection = { ...current.target };
          this.pinned = copyDisplaySnapshot(current);
        }
      }
    }
    this.displayed = this.pinned ?? (this.showCompletedUntilApplied ? latestInSession ?? current : current);
    return this.displayed;
  }

  toggle(expected?: AdviseDisplayTarget) {
    if (expected && !sameAdviseDisplayTarget(expected, this.displayed?.target)) {
      return { accepted: false, reason: "display-target-changed" };
    }
    if (this.pinned) {
      this.clear();
      this.showCompletedUntilApplied = true;
      return { accepted: true, reason: "manual-unlock" };
    }
    const sections = this.displayed?.sections;
    const hasContent = sections && [sections.primaryAnswer, sections.chineseThinking, sections.focusedQuestion,
      sections.approach, sections.whiteboard, sections.code, sections.complexity, sections.clarifyingQuestion].some(value => value.trim());
    if (!this.displayed || !hasContent || !hasLogicalQuestion(this.displayed.target) ||
        (this.displayed.streaming ? !this.displayed.target.generationId : !hasConsistentStable(this.displayed))) {
      return { accepted: false, reason: "no-visible-answer" };
    }
    this.pinned = copyDisplaySnapshot(this.displayed);
    this.selection = { ...this.pinned.target };
    this.completed = this.pinned.streaming ? null : this.pinned;
    this.showCompletedUntilApplied = false;
    return { accepted: true, reason: "manual-lock" };
  }

  capture(expected?: AdviseDisplayTarget) {
    if (expected && !sameAdviseDisplayTarget(expected, this.displayed?.target)) return null;
    return this.displayed ? structuredClone(this.displayed) : null;
  }

  revokeIncomplete(traceId?: string) {
    if (!traceId || !this.pinned?.streaming || this.pinned.target.traceId !== traceId) return false;
    // Retain the effective-revision floor even when restoring an older legal result.
    this.pinned = this.completed;
    if (!this.completed) {
      this.selection = null;
      this.showCompletedUntilApplied = true;
    }
    return true;
  }

  clear() {
    this.selection = null;
    this.pinned = null;
    this.completed = null;
    this.displayed = null;
    this.showCompletedUntilApplied = false;
  }
}
