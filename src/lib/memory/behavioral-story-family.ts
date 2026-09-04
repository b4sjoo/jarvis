import { scoreCurrentQuestionRelevance } from "./current-question-ranking.js";
import { classifyRuntimeMemoryRole } from "./runtime-role.js";
import type { MemoryEntry } from "./types.js";

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
  disposition:
    | "selected"
    | "not-behavioral"
    | "empty-query"
    | "no-valid-family"
    | "no-positive-match";
}

export function selectBehavioralStoryFamily(input: {
  entries: MemoryEntry[];
  query: string;
  questionType?: string;
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
  if (candidates[0]!.score <= 0) {
    return {
      queryChars: query.length,
      candidates,
      disposition: "no-positive-match",
    };
  }

  const selected = candidates[0]!;
  const runnerUp = candidates[1];
  return {
    queryChars: query.length,
    candidates,
    selected,
    runnerUp,
    margin: runnerUp ? selected.score - runnerUp.score : selected.score,
    disposition: "selected",
  };
}

export function formatBehavioralStoryFamilySelectionForTrace(
  selection: BehavioralStoryFamilySelection | undefined
) {
  return selection
    ? {
        behavioralStoryFamilyDisposition: selection.disposition,
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

function isBehavioralStoryFamily(entry: MemoryEntry) {
  return (
    entry.enabled &&
    entry.curationStatus === "curated" &&
    entry.type === "answer_template" &&
    entry.tags.includes(BEHAVIORAL_STORY_FAMILY_TAG)
  );
}

function isEligiblePersonalStory(entry: MemoryEntry) {
  return (
    entry.enabled &&
    entry.curationStatus === "curated" &&
    entry.type === "personal_story" &&
    classifyRuntimeMemoryRole(entry).anchorEligible
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
