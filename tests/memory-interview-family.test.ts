import assert from "node:assert/strict";
import test from "node:test";
import {
  auditMemoryInterviewFamilyNormalization,
  getMemoryInterviewFamilyGateRejectReason,
  resolveMemoryInterviewFamilyGateDecision,
  resolveMemoryInterviewFamilies,
} from "../src/lib/memory/interview-family.js";
import {
  createMemoryInterviewFamilyResolutionRecorder,
  formatMemoryInterviewFamilyResolutionForTrace,
  formatMemoryInterviewTypePriorIsolationForTrace,
} from "../src/lib/memory/interview-family-telemetry.js";
import { classifyRuntimeMemoryRole } from "../src/lib/memory/runtime-role.js";
import type { MemoryEntry } from "../src/lib/memory/types.js";

test("specialized project evidence receives families independently from runtime role", () => {
  const entry = makeEntry({
    type: "implementation_note",
    scope: "project",
    projectId: "agentic-memory",
    projectName: "Agentic Memory",
    title: "Agentic Memory retrieval pipeline",
  });

  const decision = resolveMemoryInterviewFamilies(entry);
  assert.deepEqual(decision.families, [
    "ai-ml-system-design",
    "project-deep-dive",
  ]);
  assert.equal(decision.source, "inferred");
  assert.equal(decision.resolutionReason, "independent-inferred-evidence");
  assert.equal(decision.resolutionVersion, 2);
  assert.equal(classifyRuntimeMemoryRole(entry).role, "fact-evidence");
});

test("settled question type overrides a conflicting Brief prior", () => {
  const entry = makeEntry({
    type: "personal_story",
    title: "Behavioral disagreement story",
    interviewFamilies: ["behavioral"],
  });

  assert.equal(
    getMemoryInterviewFamilyGateRejectReason({
      entry,
      interviewTypes: ["coding"],
      questionType: "behavioral",
      memoryPolicy: {
        id: "behavioral-only",
        allowedFamilies: ["behavioral"],
      },
    }),
    undefined
  );
});

test("reports the forbidden Brief prior gate as an explicit zero invariant", () => {
  assert.deepEqual(formatMemoryInterviewTypePriorIsolationForTrace([]), {
    rightFamilyBlockedByPriorCount: 0,
    memoryPriorUsedAsExecutionGate: false,
    unknownSpecializedFamilyBlockedCount: 0,
  });

  assert.deepEqual(
    formatMemoryInterviewTypePriorIsolationForTrace([
      {
        reason: "brief-interview-type-blocked",
        count: 2,
        sampleEntryIds: ["mem_behavioral_story"],
        sampleTitles: ["Behavioral story"],
      },
    ]),
    {
      rightFamilyBlockedByPriorCount: 2,
      memoryPriorUsedAsExecutionGate: true,
      unknownSpecializedFamilyBlockedCount: 0,
    }
  );
});

test("blocks specialized families until an Unknown question receives authority", () => {
  const entry = makeEntry({
    type: "personal_story",
    title: "Behavioral ownership story",
    interviewFamilies: ["behavioral"],
  });

  assert.equal(
    getMemoryInterviewFamilyGateRejectReason({
      entry,
      questionType: "unknown",
    }),
    "unknown-question-type-family-blocked"
  );
  assert.equal(
    getMemoryInterviewFamilyGateRejectReason({
      entry,
      questionType: "behavioral",
      memoryPolicy: {
        id: "behavioral",
        allowedFamilies: ["behavioral"],
      },
    }),
    undefined
  );

  assert.deepEqual(
    formatMemoryInterviewTypePriorIsolationForTrace([
      {
        reason: "unknown-question-type-family-blocked",
        count: 3,
        sampleEntryIds: ["mem_story"],
        sampleTitles: ["Behavioral ownership story"],
      },
    ]),
    {
      rightFamilyBlockedByPriorCount: 0,
      memoryPriorUsedAsExecutionGate: false,
      unknownSpecializedFamilyBlockedCount: 3,
    }
  );
});

test("uses the Field Knowledge playbook family map instead of the Unknown bypass", () => {
  const systemDesign = makeEntry({
    title: "Vector retrieval fundamentals",
    interviewFamilies: ["ai-ml-system-design"],
  });
  const behavioral = makeEntry({
    title: "Behavioral ownership story",
    interviewFamilies: ["behavioral"],
  });

  assert.equal(
    getMemoryInterviewFamilyGateRejectReason({
      entry: systemDesign,
      questionType: "field-knowledge",
    }),
    undefined
  );
  assert.equal(
    getMemoryInterviewFamilyGateRejectReason({
      entry: behavioral,
      questionType: "field-knowledge",
    }),
    "behavioral-family-blocked"
  );
});

test("settled type and playbook still block incompatible specialized fact evidence", () => {
  const entry = makeEntry({
    type: "answer_evidence",
    title: "RAG model serving evidence",
  });

  assert.equal(
    getMemoryInterviewFamilyGateRejectReason({
      entry,
      interviewTypes: ["behavioral"],
      questionType: "behavioral",
      memoryPolicy: {
        id: "behavioral-only",
        allowedFamilies: ["behavioral"],
      },
    }),
    "playbook-family-blocked"
  );
});

test("snapshot-derived type priors cannot veto a settled AI ML question", () => {
  const entry = makeEntry({
    type: "interview_framework",
    title: "RAG system design contract",
    interviewFamilies: ["ai-ml-system-design"],
  });

  assert.equal(
    getMemoryInterviewFamilyGateRejectReason({
      entry,
      interviewTypes: ["system-design"],
      questionType: "ai-ml-system-design",
      memoryPolicy: {
        id: "ai-ml-system-design",
        allowedFamilies: ["ai-ml-system-design"],
      },
    }),
    undefined
  );
});

test("multi-family memories pass when one family is explicitly allowed", () => {
  const entry = makeEntry({
    type: "implementation_note",
    scope: "project",
    projectId: "agentic-memory",
    title: "Agentic Memory architecture",
  });

  assert.equal(
    getMemoryInterviewFamilyGateRejectReason({
      entry,
      interviewTypes: ["mixed"],
      questionType: "project-deep-dive",
      memoryPolicy: {
        id: "project-only",
        allowedFamilies: ["project-deep-dive"],
      },
    }),
    undefined
  );
});

test("explicit families override inference and general memory stays general", () => {
  const explicit = resolveMemoryInterviewFamilies(
    makeEntry({
      title: "RAG notes",
      interviewFamilies: ["project-deep-dive"],
    })
  );
  assert.deepEqual(explicit.families, ["project-deep-dive"]);
  assert.equal(explicit.source, "explicit");
  assert.equal(explicit.resolutionReason, "explicit-family");
  assert.deepEqual(explicit.evidence, ["explicit:project-deep-dive"]);
  assert.deepEqual(resolveMemoryInterviewFamilies(makeEntry({})).families, [
    "general",
  ]);
});

test("behavioral evaluation language does not create an AI/ML escape family", () => {
  const decision = resolveMemoryInterviewFamilies(
    makeEntry({
      type: "evaluation_criteria",
      title: "Amazon behavioral evaluation rubric",
      useCases: ["behavioral_interview"],
    })
  );

  assert.deepEqual(decision.families, ["behavioral"]);
});

test("hyphenated and underscored specialized metadata resolves to canonical families", () => {
  assert.deepEqual(
    resolveMemoryInterviewFamilies(
      makeEntry({ tags: ["general-system-design"] })
    ).families,
    ["system-design"]
  );
  assert.deepEqual(
    resolveMemoryInterviewFamilies(
      makeEntry({ tags: ["ai_ml_system_design"] })
    ).families,
    ["ai-ml-system-design"]
  );
  assert.deepEqual(
    resolveMemoryInterviewFamilies(
      makeEntry({ tags: ["project-deep-dive"] })
    ).families,
    ["project-deep-dive"]
  );
});

test("specific family suppresses a generic family from the same evidence", () => {
  const decision = resolveMemoryInterviewFamilies(
    makeEntry({
      id: "mem_aiml_mlsd_answer_contract",
      title: "AI ML system design answer contract",
      tags: ["ai-ml-system-design", "machine-learning"],
    })
  );

  assert.deepEqual(decision.families, ["ai-ml-system-design"]);
  assert.equal(decision.resolutionReason, "specific-family-dominance");
  assert.ok(
    decision.suppressedEvidence.some(
      (item) =>
        item.family === "system-design" &&
        item.suppressedBySpecificFamily === "ai-ml-system-design"
    )
  );
});

test("independent generic evidence can intentionally supplement an inferred specialized family", () => {
  const decision = resolveMemoryInterviewFamilies(
    makeEntry({
      title: "RAG serving contract",
      tags: ["general-system-design"],
    })
  );

  assert.deepEqual(decision.families, [
    "ai-ml-system-design",
    "system-design",
  ]);
  assert.equal(decision.resolutionReason, "independent-inferred-evidence");
});

test("explicit multi-family metadata remains authoritative", () => {
  const decision = resolveMemoryInterviewFamilies(
    makeEntry({
      title: "RAG system design contract",
      interviewFamilies: ["ai-ml-system-design", "system-design"],
    })
  );

  assert.deepEqual(decision.families, [
    "ai-ml-system-design",
    "system-design",
  ]);
  assert.equal(decision.resolutionReason, "explicit-multi-family");
  assert.equal(decision.suppressedEvidence.length, 0);
});

test("coding entry type prevents inferred AI ML cross-family use without explicit metadata", () => {
  const entry = makeEntry({
    id: "mem_aiml_coding_whiteboard_trigger_pack",
    type: "coding_question",
    title: "AIML coding whiteboard trigger pack",
    tags: ["ai-ml-system-design", "coding"],
  });
  const decision = resolveMemoryInterviewFamilies(entry);

  assert.deepEqual(decision.families, ["coding"]);
  assert.ok(
    decision.suppressedEvidence.some(
      (item) => item.family === "ai-ml-system-design"
    )
  );
  assert.equal(
    getMemoryInterviewFamilyGateRejectReason({
      entry,
      questionType: "general-system-design",
      memoryPolicy: {
        id: "general-system-design",
        allowedFamilies: ["system-design"],
        blockedFamilies: ["coding", "ai-ml-system-design"],
      },
    }),
    "playbook-family-blocked"
  );
});

test("hyphenated general system-design templates are blocked by the coding playbook", () => {
  const entryIds = [
    "mem_gsd_source_truth_derived_cdc",
    "mem_gsd_sharding_consistent_hashing",
    "mem_gsd_transactions_invariants_failure",
    "mem_gsd_cache_cdn_policy",
  ];

  for (const id of entryIds) {
    const entry = makeEntry({
      id,
      title: "Reusable architecture template",
      tags: ["system-design", "general-system-design"],
    });
    assert.deepEqual(resolveMemoryInterviewFamilies(entry).families, [
      "system-design",
    ]);
    assert.equal(
      getMemoryInterviewFamilyGateRejectReason({
        entry,
        interviewTypes: ["mixed"],
        questionType: "coding",
        memoryPolicy: {
          id: "coding-only",
          allowedFamilies: ["coding"],
        },
      }),
      "playbook-family-blocked"
    );
  }
});

test("family audit preserves truly general entries and reports no normalized alias leaks", () => {
  const general = makeEntry({
    id: "mem_general_preference",
    title: "Communication preference",
    tags: ["meeting-assistant"],
  });
  const specialized = makeEntry({
    id: "mem_system_design",
    title: "Architecture template",
    tags: ["system-design"],
  });

  assert.deepEqual(resolveMemoryInterviewFamilies(general).families, ["general"]);
  assert.deepEqual(
    auditMemoryInterviewFamilyNormalization([general, specialized]),
    []
  );
});

test("replays the August 6 General SD family leak without admitting specialized entries", () => {
  const entries = [
    makeEntry({
      id: "mem_aiml_mlsd_answer_contract",
      type: "interview_framework",
      title: "AI ML system design answer contract",
      tags: ["ai-ml-system-design", "machine-learning"],
    }),
    makeEntry({
      id: "mem_gsd_answer_os",
      type: "interview_framework",
      title: "General system design answer operating system",
      tags: ["system-design", "general-system-design"],
    }),
    makeEntry({
      id: "mem_aiml_rag_system_design_contract",
      type: "interview_framework",
      title: "RAG system design contract",
      tags: ["ai-ml-system-design", "rag"],
    }),
    makeEntry({
      id: "mem_gsd_problem_classifier",
      type: "interview_framework",
      title: "General system design problem classifier",
      tags: ["system-design", "general-system-design"],
    }),
    makeEntry({
      id: "mem_aiml_coding_whiteboard_trigger_pack",
      type: "coding_question",
      title: "AIML coding whiteboard trigger pack",
      tags: ["ai-ml-system-design", "coding"],
    }),
    makeEntry({
      id: "mem_aiml_agent_design_contract",
      type: "interview_framework",
      title: "Agent system design contract",
      tags: ["ai-ml-system-design", "agent"],
    }),
  ];
  const policy = {
    id: "general_system_design",
    allowedFamilies: ["system-design" as const],
    blockedFamilies: ["coding" as const, "ai-ml-system-design" as const],
  };
  const recorder = createMemoryInterviewFamilyResolutionRecorder();
  const allowed: string[] = [];

  for (const entry of entries) {
    const decision = resolveMemoryInterviewFamilyGateDecision({
      entry,
      questionType: "general-system-design",
      memoryPolicy: policy,
    });
    recorder.record(entry.id, decision);
    if (!decision.rejectReason) allowed.push(entry.id);
  }

  assert.deepEqual(allowed, ["mem_gsd_answer_os", "mem_gsd_problem_classifier"]);
  const telemetry = recorder.summary(allowed);
  assert.equal(telemetry.resolutionVersion, 2);
  assert.equal(telemetry.familyPolicyAllowCount, 2);
  assert.equal(telemetry.familyPolicyRejectCount, 4);
  assert.ok(telemetry.specificFamilyDominanceCount >= 3);
  assert.ok(telemetry.genericSubstringSuppressedCount >= 3);
  assert.deepEqual(
    telemetry.samples
      .filter((sample) => sample.selected)
      .map((sample) => sample.entryId)
      .sort(),
    ["mem_gsd_answer_os", "mem_gsd_problem_classifier"]
  );
  const trace = formatMemoryInterviewFamilyResolutionForTrace(telemetry);
  assert.equal(trace.memoryInterviewFamilyResolutionVersion, 2);
  assert.equal(trace.memoryFamilyPolicyRejectCount, 4);
  assert.doesNotMatch(
    JSON.stringify(trace),
    /AI ML system design answer contract/
  );
});

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "mem_family",
    sourceIds: [],
    type: "field_note",
    title: "General communication preference",
    content: "Keep answers concise.",
    scope: "global",
    tags: [],
    keywords: [],
    priority: "normal",
    enabled: true,
    injectionMode: "retrieval",
    useCases: ["meeting_assistant"],
    confidentiality: "normal",
    curationStatus: "curated",
    relatedEntryIds: [],
    evidenceEntryIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
