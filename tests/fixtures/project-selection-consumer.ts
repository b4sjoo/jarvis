import assert from "node:assert/strict";
import type { MemoryEntry } from "../../src/lib/memory/types.js";

// Inputs for the approved S63 matrix. These are not a runtime adapter or evidence
// that the complete Hook has executed. Expected outcomes never enter source input.
export const S63_SOURCE_QUESTION =
  "Which project are you most familiar with, and what was your personal contribution?";
export const S63_NEXT_SOURCE_QUESTION =
  "Now solve a new coding problem: implement a least recently used cache.";

export const S63_FACT_A =
  "For Cedar Analytics, I implemented column pruning in the scan planner.";
export const S63_FACT_B =
  "For Quartz Relay, I implemented partition-key routing and per-partition retry isolation.";

export const S63_MEMORY: readonly MemoryEntry[] = [
  projectFact("cedar_analytics", "Cedar Analytics", S63_FACT_A),
  projectFact("quartz_relay", "Quartz Relay", S63_FACT_B),
];

export const S63_PROVIDER_ANSWERS = {
  initial: [
    "Answer: A useful project explanation connects the problem, constraints, decisions, and evidence.",
    "Clarifying question: -",
    "Clarifying options: -",
  ].join("\n\n"),
  selected: [
    `Answer: ${S63_FACT_B}`,
    "Clarifying question: -",
    "Clarifying options: -",
  ].join("\n\n"),
};

export type S63CaseId =
  | "S63-N1" | "S63-F1" | "S63-N2" | "S63-F2"
  | "S63-N3" | "S63-F3" | "S63-N4" | "S63-F4";

export interface S63ConsumerExecution {
  executionId: string;
  caseId: S63CaseId;
  surface: "normal" | "focus";
  source: "voice" | "screen";
  behavior: "success" | "provider-failure-retry" | "duplicate-click" | "owner-change";
  pauseAt?: "storage-before-binding" | "provider-after-binding";
}

export const S63_CONSUMER_EXECUTIONS: readonly S63ConsumerExecution[] = [
  { executionId: "S63-N1", caseId: "S63-N1", surface: "normal", source: "voice", behavior: "success" },
  { executionId: "S63-F1", caseId: "S63-F1", surface: "focus", source: "screen", behavior: "success" },
  { executionId: "S63-N2", caseId: "S63-N2", surface: "normal", source: "voice", behavior: "provider-failure-retry" },
  { executionId: "S63-F2", caseId: "S63-F2", surface: "focus", source: "screen", behavior: "provider-failure-retry" },
  { executionId: "S63-N3", caseId: "S63-N3", surface: "normal", source: "screen", behavior: "duplicate-click" },
  { executionId: "S63-F3", caseId: "S63-F3", surface: "focus", source: "voice", behavior: "duplicate-click" },
  { executionId: "S63-N4-before", caseId: "S63-N4", surface: "normal", source: "screen", behavior: "owner-change", pauseAt: "storage-before-binding" },
  { executionId: "S63-N4-after", caseId: "S63-N4", surface: "normal", source: "screen", behavior: "owner-change", pauseAt: "provider-after-binding" },
  { executionId: "S63-F4-before", caseId: "S63-F4", surface: "focus", source: "voice", behavior: "owner-change", pauseAt: "storage-before-binding" },
  { executionId: "S63-F4-after", caseId: "S63-F4", surface: "focus", source: "voice", behavior: "owner-change", pauseAt: "provider-after-binding" },
];

/** Call at the external Provider boundary before releasing the selected response. */
export function assertS63SelectedProviderPrompt(prompt: string) {
  assert.ok(prompt.includes(S63_FACT_B), "actual outbound Prompt must contain the selected project's authorized fact body");
  assert.ok(!prompt.includes(S63_FACT_A), "a project name in the directory is allowed; the other project's fact body is not");
}

// These are existing product observations to collect from one real execution.
// None is permission to substitute a domain owner with a test implementation.
export const S63_REQUIRED_OBSERVATIONS = [
  "accepted Voice turn or Screen observation and its runtime-created identity",
  "unbound parent and current displayed owner before selection",
  "readProjectChoicePresentation for that displayed owner, with empty model clarifying text",
  "actual Normal button or Focus transport request entering handleClarifyingAnswer",
  "answerClarifyingQuestion request ID and its terminal outcome",
  "Project Binding commit receipt and parent/binding revisions before and after",
  "outbound Provider Prompt before the controlled response is released",
  "generation lease, Plan ownership and real publication authorization result",
  "published suggestion, selectAdviseDisplay result and Focus snapshot acknowledgement",
  "Session Recording trace saved and read back through controlled storage",
] as const;

export const S63_EXECUTION_CONSTRAINTS = {
  controlledBoundaries: ["provider", "storage", "transport", "clock"],
  forbiddenSubstitutions: [
    "answerClarifyingQuestion", "runAdvisor", "captureScreenContext",
    "resolveProjectBinding", "commitProjectBindingSettlement", "submitTaskRuntimeTransition",
    "settledAdvisorExecutionPlan", "generationDerivedCommitCoordinator",
    "prepareStableAnswerPublication", "installPreparedStableAnswerPublication", "finalizeStableAnswerPublication",
  ],
  preBindingPause: "Hold the actual external snapshot read. A warm cache must be invalidated through an existing production data operation; pausing a synthetic binding callback is not evidence.",
  postBindingPause: "Hold the external Provider stream after checking the actual bound-project Prompt; introduce the next source through its real ingress, then release the old response.",
  screenFixture: "Supply a synthetic question screenshot through the existing capture transport and preserve its observation/image identity. A blank image plus an invented task is not a source fixture.",
  completion: "Run all ten executions through the real Hook browser test; isolated UI, domain and publication results cannot be added together as a pass.",
} as const;

function projectFact(projectId: string, projectName: string, content: string): MemoryEntry {
  return {
    id: `s63_fact_${projectId}`, sourceIds: [`s63_source_${projectId}`],
    type: "implementation_note", title: `${projectName} implementation evidence`, content,
    scope: "project", projectId, projectName, tags: [], keywords: [], priority: "high",
    enabled: true, injectionMode: "retrieval", useCases: ["project_deep_dive"],
    interviewFamilies: ["project-deep-dive"], confidentiality: "normal", curationStatus: "verified",
    relatedEntryIds: [], evidenceEntryIds: [], createdAt: 1, updatedAt: 1,
  };
}
