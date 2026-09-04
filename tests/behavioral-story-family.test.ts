import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  formatBehavioralStoryFamilySelectionForTrace,
  selectBehavioralStoryFamily,
  shouldAdmitBehavioralFamilyLinkedStory,
} from "../src/lib/memory/behavioral-story-family.js";
import type { MemoryEntry } from "../src/lib/memory/types.js";

test("selects one family and its only reviewed personal story", () => {
  const costStory = entry({
    id: "story-cost",
    type: "personal_story",
    title: "AOS test account cleanup",
  });
  const conflictStory = entry({
    id: "story-conflict",
    type: "personal_story",
    title: "Agentic Memory design conflict",
  });
  const selection = selectBehavioralStoryFamily({
    entries: [
      family({
        id: "family-cost",
        title: "Cost and operational efficiency",
        keywords: ["cost", "waste", "resources", "efficiency"],
        evidenceEntryIds: [costStory.id],
      }),
      family({
        id: "family-conflict",
        title: "Conflict influence and judgment",
        keywords: ["conflict", "disagreement", "influence", "tradeoff"],
        evidenceEntryIds: [conflictStory.id],
      }),
      costStory,
      conflictStory,
    ],
    query: "Tell me about a disagreement where you influenced the decision.",
    questionType: "behavioral",
  });

  assert.equal(selection.disposition, "selected");
  assert.equal(selection.selected?.family.id, "family-conflict");
  assert.equal(selection.selected?.story.id, "story-conflict");
  assert.equal(selection.runnerUp?.family.id, "family-cost");
  assert.ok((selection.margin ?? 0) > 0);
  assert.deepEqual(
    formatBehavioralStoryFamilySelectionForTrace(selection),
    {
      behavioralStoryFamilyDisposition: "selected",
      behavioralStoryFamilySelectionSource: "query",
      behavioralStoryFamilyQueryChars: 63,
      behavioralStoryFamilyCandidateCount: 2,
      behavioralStoryFamilySelectedId: "family-conflict",
      behavioralStoryFamilySelectedStoryId: "story-conflict",
      behavioralStoryFamilySelectedScore: 10,
      behavioralStoryFamilyRunnerUpId: "family-cost",
      behavioralStoryFamilyRunnerUpScore: 0,
      behavioralStoryFamilyMargin: 10,
      behavioralStoryFamilyCandidates: [
        {
          familyId: "family-conflict",
          storyId: "story-conflict",
          score: 10,
          titleMatches: 0,
          tagMatches: 0,
          keywordMatches: 1,
          contentMatches: 0,
        },
        {
          familyId: "family-cost",
          storyId: "story-cost",
          score: 0,
          titleMatches: 0,
          tagMatches: 0,
          keywordMatches: 0,
          contentMatches: 0,
        },
      ],
    }
  );
});

test("preserves an active branch story instead of reranking a generic follow-up", () => {
  const costStory = entry({
    id: "story-cost",
    type: "personal_story",
    title: "AOS cleanup story",
  });
  const conflictStory = entry({
    id: "story-conflict",
    type: "personal_story",
    title: "Agentic Memory conflict story",
  });
  const selection = selectBehavioralStoryFamily({
    entries: [
      family({
        id: "family-cost",
        title: "Cost efficiency",
        keywords: ["cost", "result"],
        evidenceEntryIds: [costStory.id],
      }),
      family({
        id: "family-conflict",
        title: "Conflict influence",
        keywords: ["conflict", "result"],
        evidenceEntryIds: [conflictStory.id],
      }),
      costStory,
      conflictStory,
    ],
    query: "And then?",
    questionType: "behavioral",
    preferredStoryAnchors: [conflictStory.title],
  });

  assert.equal(selection.selectionSource, "active-story-anchor");
  assert.equal(selection.selected?.story.id, conflictStory.id);
});

test("does not switch stories through a shared project alias", () => {
  const conflictStory = entry({
    id: "story-conflict",
    type: "personal_story",
    title: "Agentic Memory consistency conflict",
    projectId: "agentic-memory",
    projectName: "Agentic Memory",
  });
  const failureStory = entry({
    id: "story-failure",
    type: "personal_story",
    title: "Agentic Memory JSON failure",
    projectId: "agentic-memory",
    projectName: "Agentic Memory",
  });
  const entries = [
    family({
      id: "family-conflict",
      title: "Conflict influence",
      keywords: ["conflict", "disagreement"],
      evidenceEntryIds: [conflictStory.id],
    }),
    family({
      id: "family-failure",
      title: "Failure recovery",
      keywords: ["failure", "mistake", "recovery"],
      evidenceEntryIds: [failureStory.id],
    }),
    conflictStory,
    failureStory,
  ];

  const preserved = selectBehavioralStoryFamily({
    entries,
    query: "What failed, and how did you recover from the mistake?",
    questionType: "behavioral",
    preferredStoryAnchors: [conflictStory.title, "Agentic Memory"],
  });
  assert.equal(preserved.selectionSource, "active-story-anchor");
  assert.equal(preserved.selected?.story.id, conflictStory.id);

  const projectOnly = selectBehavioralStoryFamily({
    entries,
    query: "What failed, and how did you recover from the mistake?",
    questionType: "behavioral",
    preferredStoryAnchors: ["Agentic Memory"],
  });
  assert.equal(projectOnly.selectionSource, "query");
  assert.equal(projectOnly.selected?.story.id, failureStory.id);
});

test("overrides only the generic project-scope rejection for the selected story", () => {
  assert.equal(
    shouldAdmitBehavioralFamilyLinkedStory({
      selectedStoryId: "story-1",
      entryId: "story-1",
      eligible: false,
      rejectReason: "general-without-positive-scope",
    }),
    true
  );
  for (const rejectReason of [
    "project-anchor-mismatch",
    "question-type-family-mismatch",
    "use-case-mismatch",
    "uncurated",
  ]) {
    assert.equal(
      shouldAdmitBehavioralFamilyLinkedStory({
        selectedStoryId: "story-1",
        entryId: "story-1",
        eligible: false,
        rejectReason,
      }),
      false
    );
  }
});

test("keeps runner-up observational and rejects invalid family links", () => {
  const story = entry({
    id: "story-deadline",
    type: "personal_story",
    title: "Deadline delivery",
  });
  const selection = selectBehavioralStoryFamily({
    entries: [
      family({
        id: "family-deadline",
        title: "Deadline and delivery",
        keywords: ["deadline", "delivery"],
        evidenceEntryIds: [story.id],
      }),
      family({
        id: "family-invalid",
        title: "Invalid family",
        keywords: ["deadline"],
        evidenceEntryIds: ["story-a", "story-b"],
      }),
      story,
    ],
    query: "Describe a tight deadline and how you delivered.",
    questionType: "behavioral",
  });

  assert.equal(selection.disposition, "selected");
  assert.equal(selection.selected?.family.id, "family-deadline");
  assert.equal(selection.candidates.length, 1);
});

test("does not force an arbitrary story without a positive family match", () => {
  const story = entry({
    id: "story-cost",
    type: "personal_story",
    title: "AOS cleanup",
  });
  const selection = selectBehavioralStoryFamily({
    entries: [
      family({
        id: "family-cost",
        title: "Cost efficiency",
        keywords: ["cost", "waste"],
        evidenceEntryIds: [story.id],
      }),
      story,
    ],
    query: "Describe an experience that matters to you.",
    questionType: "behavioral",
  });

  assert.equal(selection.disposition, "no-positive-match");
  assert.equal(selection.selected, undefined);
});

test("does not run family selection outside Behavioral", () => {
  const selection = selectBehavioralStoryFamily({
    entries: [],
    query: "How would you design a cache?",
    questionType: "coding",
  });
  assert.equal(selection.disposition, "not-behavioral");
});

test("wires Answer Focus and active story continuity into production retrieval", () => {
  const hook = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
  const retrieval = readFileSync("src/lib/memory/retrieval.ts", "utf8");

  assert.match(
    hook,
    /behavioralStoryQuery:\s*advisorQuestionAnswerFocusText\s*\|\|\s*advisorCurrentQuestionEvidenceText/
  );
  assert.match(
    hook,
    /preferredBehavioralStoryAnchors:[\s\S]{0,220}effectiveAdvisorSettlementView\.supportedFactAnchors/
  );
  assert.match(
    retrieval,
    /const selected = \[\.\.\.behavioralFamilyEntries, \.\.\.ordinaryEntries\]/
  );
  assert.match(
    retrieval,
    /questionType === "behavioral" &&\s*entry\.type === "personal_story"/
  );
});

function family(input: Partial<MemoryEntry> & Pick<MemoryEntry, "id" | "title">) {
  return entry({
    ...input,
    type: "answer_template",
    tags: ["behavioral-story-family", ...(input.tags ?? [])],
  });
}

function entry(
  input: Partial<MemoryEntry> & Pick<MemoryEntry, "id" | "title" | "type">
): MemoryEntry {
  return {
    id: input.id,
    sourceIds: input.sourceIds ?? ["source-1"],
    type: input.type,
    title: input.title,
    content: input.content ?? "",
    summary: input.summary,
    scope: input.scope ?? "global",
    projectId: input.projectId,
    projectName: input.projectName,
    tags: input.tags ?? [],
    keywords: input.keywords ?? [],
    priority: input.priority ?? "high",
    enabled: input.enabled ?? true,
    injectionMode: input.injectionMode ?? "retrieval",
    useCases: input.useCases ?? ["meeting_assistant", "behavioral_interview"],
    interviewFamilies: input.interviewFamilies ?? ["behavioral"],
    confidentiality: input.confidentiality ?? "sensitive",
    curationStatus: input.curationStatus ?? "curated",
    relatedEntryIds: input.relatedEntryIds ?? [],
    evidenceEntryIds: input.evidenceEntryIds ?? [],
    createdAt: input.createdAt ?? 1,
    updatedAt: input.updatedAt ?? 1,
  };
}
