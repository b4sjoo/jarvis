import { scoreCurrentQuestionRelevance } from "./current-question-ranking.js";
import { classifyRuntimeMemoryRole } from "./runtime-role.js";
import { resolveMemoryInterviewFamilies } from "./interview-family.js";
import type {
  MemoryBehavioralStoryFamilySelectionSummary,
  MemoryEntry,
} from "./types.js";

export const BEHAVIORAL_STORY_FAMILY_TAG = "behavioral-story-family";

export interface BehavioralStoryFamilyCandidate {
  family: MemoryEntry;
  story: MemoryEntry;
  score: number;
  titleMatches: number;
  tagMatches: number;
  keywordMatches: number;
  contentMatches: number;
}

export interface BehavioralStoryFamilySelection {
  queryChars: number;
  candidates: BehavioralStoryFamilyCandidate[];
  selected?: BehavioralStoryFamilyCandidate;
  runnerUp?: BehavioralStoryFamilyCandidate;
  margin?: number;
  selectionSource?: "query" | "active-story-anchor";
  disposition:
    | "selected"
    | "not-behavioral"
    | "empty-query"
    | "no-valid-family"
    | "no-positive-match";
}

export function selectBehavioralStoryFamily(input: {
  entries: readonly MemoryEntry[];
  query: string;
  questionType?: string;
  preferredStoryAnchors?: string[];
}): BehavioralStoryFamilySelection {
  const query = input.query.trim();
  if (input.questionType !== "behavioral") {
    return emptySelection(query.length, "not-behavioral");
  }
  if (!query) return emptySelection(0, "empty-query");

  const entriesById = new Map(input.entries.map((entry) => [entry.id, entry]));
  const queryTokens = tokenize(query);
  const candidates = input.entries
    .filter(isBehavioralStoryFamily)
    .flatMap((family): BehavioralStoryFamilyCandidate[] => {
      if (family.evidenceEntryIds.length !== 1) return [];
      const story = entriesById.get(family.evidenceEntryIds[0]!);
      if (!story || !isEligiblePersonalStory(story)) return [];
      const relevance = scoreCurrentQuestionRelevance(family, queryTokens);
      return [
        {
          family,
          story,
          ...relevance,
        },
      ];
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.family.id.localeCompare(right.family.id)
    );

  if (!candidates.length) {
    return emptySelection(query.length, "no-valid-family");
  }
  const preferredAnchors = new Set(
    (input.preferredStoryAnchors ?? [])
      .map(normalizeAnchor)
      .filter(Boolean)
  );
  const preserved = candidates.find((candidate) =>
    storyIdentityAnchorValues(candidate.story).some((value) =>
      preferredAnchors.has(value)
    )
  );
  if (candidates[0]!.score <= 0 && !preserved) {
    return {
      queryChars: query.length,
      candidates,
      disposition: "no-positive-match",
    };
  }
  const selected = preserved ?? candidates[0]!;
  const runnerUp = candidates.find(
    (candidate) => candidate.family.id !== selected.family.id
  );
  return {
    queryChars: query.length,
    candidates,
    selected,
    runnerUp,
    margin: runnerUp ? selected.score - runnerUp.score : selected.score,
    selectionSource: preserved ? "active-story-anchor" : "query",
    disposition: "selected",
  };
}

export function summarizeBehavioralStoryFamilySelection(
  selection: BehavioralStoryFamilySelection | undefined
): MemoryBehavioralStoryFamilySelectionSummary | undefined {
  return selection
    ? {
        disposition: selection.disposition,
        selectionSource: selection.selectionSource,
        queryChars: selection.queryChars,
        candidateCount: selection.candidates.length,
        selectedFamilyId: selection.selected?.family.id,
        selectedStoryId: selection.selected?.story.id,
        selectedScore: selection.selected?.score,
        runnerUpFamilyId: selection.runnerUp?.family.id,
        runnerUpScore: selection.runnerUp?.score,
        margin: selection.margin,
      }
    : undefined;
}

export function shouldAdmitBehavioralFamilyLinkedStory(input: {
  selectedStoryId?: string;
  entryId: string;
  eligible: boolean;
  rejectReason?: string;
}) {
  return Boolean(
    input.selectedStoryId === input.entryId &&
      !input.eligible &&
      input.rejectReason === "general-without-positive-scope"
  );
}

export function formatBehavioralStoryFamilySelectionForTrace(
  selection: BehavioralStoryFamilySelection | undefined
) {
  return selection
    ? {
        behavioralStoryFamilyDisposition: selection.disposition,
        behavioralStoryFamilySelectionSource: selection.selectionSource,
        behavioralStoryFamilyQueryChars: selection.queryChars,
        behavioralStoryFamilyCandidateCount: selection.candidates.length,
        behavioralStoryFamilySelectedId: selection.selected?.family.id,
        behavioralStoryFamilySelectedStoryId: selection.selected?.story.id,
        behavioralStoryFamilySelectedScore: selection.selected?.score,
        behavioralStoryFamilyRunnerUpId: selection.runnerUp?.family.id,
        behavioralStoryFamilyRunnerUpScore: selection.runnerUp?.score,
        behavioralStoryFamilyMargin: selection.margin,
        behavioralStoryFamilyCandidates: selection.candidates.map(
          (candidate) => ({
            familyId: candidate.family.id,
            storyId: candidate.story.id,
            score: candidate.score,
            titleMatches: candidate.titleMatches,
            tagMatches: candidate.tagMatches,
            keywordMatches: candidate.keywordMatches,
            contentMatches: candidate.contentMatches,
          })
        ),
      }
    : {};
}

function storyIdentityAnchorValues(entry: MemoryEntry) {
  return [entry.id, entry.title]
    .map(normalizeAnchor)
    .filter(Boolean);
}

function normalizeAnchor(value: string | undefined) {
  return value?.normalize("NFKC").trim().toLowerCase() ?? "";
}

function isBehavioralStoryFamily(entry: MemoryEntry) {
  return (
    entry.enabled &&
    entry.curationStatus === "curated" &&
    entry.type === "answer_template" &&
    entry.tags.includes(BEHAVIORAL_STORY_FAMILY_TAG) &&
    hasBehavioralUseCase(entry) &&
    resolveMemoryInterviewFamilies(entry).families.includes("behavioral")
  );
}

function isEligiblePersonalStory(entry: MemoryEntry) {
  return (
    entry.enabled &&
    entry.curationStatus === "curated" &&
    entry.type === "personal_story" &&
    hasBehavioralUseCase(entry) &&
    resolveMemoryInterviewFamilies(entry).families.includes("behavioral") &&
    classifyRuntimeMemoryRole(entry).anchorEligible
  );
}

function hasBehavioralUseCase(entry: MemoryEntry) {
  return (
    entry.useCases.includes("behavioral_interview") ||
    entry.useCases.includes("meeting_assistant")
  );
}

function tokenize(value: string) {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9+#.]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1)
  );
}

function emptySelection(
  queryChars: number,
  disposition: BehavioralStoryFamilySelection["disposition"]
): BehavioralStoryFamilySelection {
  return { queryChars, candidates: [], disposition };
}
