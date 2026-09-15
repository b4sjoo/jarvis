import assert from "node:assert/strict";
import test from "node:test";
import { memoryEntry, preparationPurposeFixture } from "./helpers/preparation-purpose-fixture.js";
import type { MemoryEntry, MemoryRetrievalRequest, MemoryRetrievalResult } from "../src/lib/memory/types.js";
import { classifyRuntimeMemoryRole } from "../src/lib/memory/runtime-role.js";
import { createPreparationContextComposer, normalizePreparationRetrievalQuery } from "../src/lib/preparation/context-composer.js";
import { createPreparationConversationExecutionService } from "../src/lib/preparation/conversation-execution.js";
import type { PreparationFetchRequest } from "../src/lib/preparation/context-types.js";

// Recorded query with an equivalent anonymized story shape. Real-data proof stays
// in private acceptance artifacts; committed tests never open the production DB.
const OWN_FAILURE_QUERY = "\u5f53\u524d\u8fd9\u4e2aOwn Without Ego\u66f4\u591a\u7684\u662f\u522b\u4eba\u7684\u95ee\u9898\u5f71\u54cd\u4e86\u6211\u4eec\u81ea\u5df1\uff0c\u6211\u4eec\u53ea\u662ffollow senior\u7684\u51b3\u7b56\u6362\u4e86\u5f53\u524d\u5b9e\u73b0\uff0c\u5982\u679c\u8981\u9009\u4e00\u4e2a\u66f4\u5f3a\u8c03\u5173\u4e8e\u81ea\u5df1\u7684failure\u7684story\uff0c\u6709\u6ca1\u6709\u4ec0\u4e48\u9009\u9879\uff1f";
const RECORDED_STORY: MemoryEntry = {
  id: "fixture_structured_output_failure_recovery",
  contentRevision: 1,
  sourceRevisions: { fixture_source: 1 },
  sourceIds: ["fixture_source"],
  type: "personal_story",
  title: "Structured-output failure and recovery",
  content: "In a sample project, an engineer investigated a recurring structured-output failure. They reproduced invalid JSON, identified the parser boundary, recovered valid wrapped output and kept malformed responses visible. The retrospective described the original assumption, the engineer's own corrective work and remaining validation limits. This synthetic fixture is not a candidate fact.",
  summary: "A fixture about debugging JSON failure, bounded recovery and learning.",
  scope: "project",
  projectId: "sample_project",
  projectName: "Sample Project",
  tags: ["behavioral", "failure", "recovery", "debugging", "learning", "llm", "json"],
  keywords: ["failure", "mistake", "invalid json", "code fence", "model output", "parser", "root cause", "recovery", "xml prompt", "learned"],
  priority: "high",
  enabled: true,
  injectionMode: "retrieval",
  useCases: ["meeting_assistant", "behavioral_interview", "answer_alignment"],
  interviewFamilies: ["behavioral"],
  confidentiality: "sensitive",
  curationStatus: "curated",
  relatedEntryIds: ["fixture_failure_family"],
  evidenceEntryIds: [],
  createdAt: 1,
  updatedAt: 1,
};
const BASE_REQUEST: MemoryRetrievalRequest = {
  query: normalizePreparationRetrievalQuery(OWN_FAILURE_QUERY),
  useCase: "general_chat",
  maxEntries: 3,
  maxChars: 4000,
  perEntryMaxChars: 1600,
};
type Fixture = Awaited<ReturnType<typeof preparationPurposeFixture>>;

function assertRejected(result: MemoryRetrievalResult, id: string, reason: string) {
  assert.ok(result.rejectSummary.some((r) => r.reason === reason && r.sampleEntryIds.includes(id)), `${id}: ${reason}`);
  assert.ok(!result.entries.some((item) => item.entry.id === id));
}

function withoutTiming(result: MemoryRetrievalResult) {
  const { performance: _performance, interviewFamilyResolution, ...rest } = result;
  const { evaluationMs: _evaluationMs, ...family } = interviewFamilyResolution ?? {};
  return { ...rest, interviewFamilyResolution: family };
}

function composer(h: Fixture) {
  return createPreparationContextComposer({
    materials: h.contextRepo, materialInventory: h.materialRepo, retrieveKmb: h.retrieveKmb,
  });
}

async function executePreparation(h: Fixture, content = OWN_FAILURE_QUERY) {
  let request: PreparationFetchRequest | undefined;
  const execution = createPreparationConversationExecutionService({
    conversations: h.conversations, interviewProcesses: h.interviewProcesses, materials: h.materialRepo,
    contextComposer: composer(h),
    materialExtraction: {
      async inspect() { throw new Error("No extraction"); },
      async commitCloudImageText() { throw new Error("No OCR"); },
      async commitRecoveredText() { throw new Error("No recovery"); },
      async flagQuality() { throw new Error("No review mutation"); },
    },
    imageGateway: {
      async read() { throw new Error("No image"); },
      async readVisuals() { throw new Error("No visual recovery"); },
    },
    fetchQueryResponseEvents: async function* () { throw new Error("No model query in no-history fixture"); },
    fetchResponse: async function* (input) {
      request = input;
      yield "Transport fixture only; this response does not establish model quality.";
    },
  });
  const result = await execution.execute({
    processId: "p", conversationId: h.conversation.id, content,
    route: {
      status: "ready", selectedProvider: { provider: "fixture", variables: {} },
      provider: { id: "fixture", name: "Fixture", curl: "unused" } as never,
      missingRequiredVariables: [], supportsVision: false,
    },
  });
  assert.equal(result.status, "committed");
  assert.ok(request);
  const detail = await h.conversations.load("p", h.conversation.id);
  const snapshot = detail.messages.at(-1)?.contextSnapshot;
  assert.ok(snapshot);
  return { request, snapshot };
}

test("PM-D1/D2 recorded own-failure query discovers an equivalent story without a project anchor; Meeting retains its rejection", async () => {
  const h = await preparationPurposeFixture();
  try {
    h.memory.push(structuredClone(RECORDED_STORY));
    const before = structuredClone(h.memory);
    assert.ok(!BASE_REQUEST.query.includes("sample_project"));
    const meeting = await h.retrieveKmb(BASE_REQUEST);
    assertRejected(meeting, RECORDED_STORY.id, "general-without-positive-scope");
    const preparation = await h.retrieveKmb({ ...BASE_REQUEST, preparationPurpose: "personal-context" });
    assert.equal(preparation.eligibleCount, 1);
    assert.equal(preparation.entries.length, 1);
    assert.deepEqual(preparation.entries[0].entry, RECORDED_STORY);
    assert.equal(preparation.entries[0].injectedContent, RECORDED_STORY.content);
    assert.deepEqual(preparation.entries[0].runtimeRole, classifyRuntimeMemoryRole(RECORDED_STORY));
    assert.ok(preparation.entries[0].matchReason.some((reason) => reason.startsWith("keywords:")));
    assert.deepEqual(withoutTiming(await h.retrieveKmb(BASE_REQUEST)), withoutTiming(meeting));
    assert.deepEqual(withoutTiming(await h.retrieveKmb({ ...BASE_REQUEST, preparationPurpose: undefined })), withoutTiming(meeting));
    assert.deepEqual(withoutTiming(await h.retrieveKmb({ ...BASE_REQUEST, preparationPurpose: "personal-context" })), withoutTiming(preparation));
    assert.deepEqual(h.memory, before);
  } finally { h.close(); }
});

test("PM-D1/D2 only Preparation bypasses Meeting use-case, question/family, strict project and tag gates", async () => {
  const cases: Array<{
    entry?: Partial<MemoryEntry>;
    request?: Partial<MemoryRetrievalRequest>;
    reason: string;
  }> = [
    { entry: { useCases: ["behavioral_interview", "answer_alignment"] }, reason: "use-case-mismatch" },
    { request: { questionType: "coding" }, reason: "behavioral-family-blocked" },
    { request: { questionType: "unknown" }, reason: "unknown-question-type-family-blocked" },
    { request: { memoryPolicy: { id: "blocked", blockedFamilies: ["behavioral"] } }, reason: "playbook-family-blocked" },
    { request: { memoryPolicy: { id: "allowed", allowedFamilies: ["coding"] } }, reason: "playbook-family-blocked" },
    { request: { memoryPolicy: { id: "wrong-project", strictProjectAnchor: "Other Project" } }, reason: "project-anchor-mismatch" },
    { entry: { tags: [...RECORDED_STORY.tags, "company:oracle", "lp:own-without-ego"] }, request: { projectId: RECORDED_STORY.projectId }, reason: "missing-required-tag-hint" },
  ];
  const h = await preparationPurposeFixture();
  try {
    for (const scenario of cases) {
      h.memory.splice(0, h.memory.length, { ...structuredClone(RECORDED_STORY), ...scenario.entry });
      const request = { ...BASE_REQUEST, ...scenario.request };
      const meeting = await h.retrieveKmb(request);
      assertRejected(meeting, RECORDED_STORY.id, scenario.reason);
      const preparation = await h.retrieveKmb({ ...request, preparationPurpose: "personal-context" });
      assert.deepEqual(preparation.entries.map((item) => item.entry.id), [RECORDED_STORY.id], scenario.reason);
      assert.deepEqual(withoutTiming(await h.retrieveKmb(request)), withoutTiming(meeting));
    }
    const overlay = memoryEntry("overlay", "architecture_diagram", {
      title: "Failure recovery architecture", content: "Failure recovery layout", keywords: ["failure"],
    });
    h.memory.splice(0, h.memory.length, overlay);
    assertRejected(await h.retrieveKmb(BASE_REQUEST), overlay.id, "diagram-overlay-question-type-blocked");
    const guidance = await h.retrieveKmb({ ...BASE_REQUEST, preparationPurpose: "guidance" });
    assert.equal(guidance.entries[0]?.entry.id, overlay.id);
    assert.deepEqual(guidance.entries[0].runtimeRole, classifyRuntimeMemoryRole(overlay));
    assert.equal(guidance.entries[0].runtimeRole?.anchorEligible, false);
  } finally { h.close(); }
});

test("PM-D1 Preparation behavioral discovery does not require or traverse a linked family catalog", async () => {
  const h = await preparationPurposeFixture();
  try {
    h.memory.push(structuredClone(RECORDED_STORY));
    const result = await h.retrieveKmb({ ...BASE_REQUEST, preparationPurpose: "personal-context", questionType: "behavioral" });
    assert.deepEqual(result.entries.map((item) => item.entry.id), [RECORDED_STORY.id]);
    assert.equal(result.behavioralStoryFamilySelection, undefined);
    assert.ok(result.entries.every((item) => item.matchReason.every((reason) => !reason.startsWith("behavioral-family"))));
    const irrelevant = await h.retrieveKmb({ ...BASE_REQUEST, preparationPurpose: "personal-context", query: "quartz crystal lattice" });
    assert.equal(irrelevant.eligibleCount, 1);
    assertRejected(irrelevant, RECORDED_STORY.id, "no-retrieval-match");
  } finally { h.close(); }
});

test("PM-D2 Meeting selects its bound project and rejects the relevant wrong-project story before and after Preparation", async () => {
  const h = await preparationPurposeFixture();
  try {
    h.memory.push(structuredClone(RECORDED_STORY), memoryEntry("bound-project", "personal_story", {
      title: "failure", keywords: ["failure"], content: "Failure evidence for the bound project.",
      scope: "project", projectId: "other", projectName: "Other Project",
    }));
    const request = { ...BASE_REQUEST, projectId: "other", memoryPolicy: { id: "meeting", strictProjectAnchor: "Other Project" } };
    const before = await h.retrieveKmb(request);
    assert.deepEqual(before.entries.map((item) => item.entry.id), ["bound-project"]);
    assertRejected(before, RECORDED_STORY.id, "project-anchor-mismatch");
    const discovery = await h.retrieveKmb({ ...request, preparationPurpose: "personal-context" });
    assert.equal(discovery.eligibleCount, 2);
    assert.ok(discovery.entries.some((item) => item.entry.id === RECORDED_STORY.id));
    assert.deepEqual(withoutTiming(await h.retrieveKmb(request)), withoutTiming(before));
  } finally { h.close(); }
});

test("PM-D3 common source safeguards and purpose remain enforced through the final request", async () => {
  const h = await preparationPurposeFixture();
  try {
    const blocked: Array<[string, Partial<MemoryEntry>]> = [
      ["disabled", { enabled: false }],
      ["raw", { curationStatus: "raw" }],
      ["extracted", { curationStatus: "extracted" }],
      ["stale", { curationStatus: "stale" }],
      ["manual", { injectionMode: "manual_only" }],
      ["never", { injectionMode: "never" }],
    ];
    for (const type of ["personal_story", "interview_framework"] as const) {
      h.memory.push(...blocked.map(([id, overrides]) => memoryEntry(`${type}-${id}`, type, {
        title: "failure", keywords: ["failure"], priority: "pinned", injectionMode: "always",
        content: `FORBIDDEN_${type}_${id}`, ...overrides,
      })));
    }
    h.memory.push(structuredClone(RECORDED_STORY), memoryEntry("verified-guide", "interview_framework", {
      title: "failure", keywords: ["failure"], curationStatus: "verified", content: "Verified failure guidance.",
    }));
    const before = structuredClone(h.memory);
    for (const purpose of ["guidance", "personal-context"] as const) {
      const result = await h.retrieveKmb({ ...BASE_REQUEST, preparationPurpose: purpose });
      assert.deepEqual(result.rejectSummary.map(({ reason, count }) => [reason, count]).sort(), [
        ["disabled", 2], ["manual-or-never", 4], ["uncurated", 6], ["preparation-purpose-mismatch", 1],
      ].sort());
      const otherId = purpose === "guidance" ? RECORDED_STORY.id : "verified-guide";
      assertRejected(result, otherId, "preparation-purpose-mismatch");
      assert.equal(result.entries.length, 1);
    }
    const { request, snapshot } = await executePreparation(h);
    assert.doesNotMatch(request.userMessage, /FORBIDDEN_/);
    assert.deepEqual(snapshot.sourceRefs.map((ref) => ref.id).sort(), [RECORDED_STORY.id, "verified-guide"].sort());
    assert.deepEqual(h.memory, before);
  } finally { h.close(); }
});

test("PM-D3/D4 production retrieval -> material SQL -> composition -> final request includes the full story and unchanged source refs/caps", async () => {
  const h = await preparationPurposeFixture();
  try {
    await h.material("principle", "guidance", { chunks: 4, content: "Own Without Ego failure guidance." });
    await h.material("experience", "personal-context", { chunks: 4, content: "User uploaded failure discussion." });
    await h.material("unreviewed-block", "personal-context", { review: true, content: "FORBIDDEN_REVIEW failure" });
    await h.material("wrong-round", "personal-context", { round: true, content: "FORBIDDEN_SCOPE failure" });
    await h.material("unlabelled", undefined, { content: "FORBIDDEN_LABEL failure" });
    h.memory.push(structuredClone(RECORDED_STORY),
      memoryEntry("behavioral-only", "personal_story", {
        title: "failure", keywords: ["failure"],
        content: "Another candidate with behavioral-only use cases. " + "Review original actions without assuming fault. ".repeat(28),
        useCases: ["behavioral_interview", "answer_alignment"], scope: "project", projectId: "other",
      }),
      ...[0, 1, 2].map((i) => memoryEntry(`guide-${i}`, "interview_framework", {
        title: "failure", keywords: ["failure"], content: `Failure guidance ${i}.`,
      })));
    const beforeMemory = structuredClone(h.memory);
    const beforeSources = h.db.prepare("SELECT * FROM preparation_source_refs ORDER BY id").all();
    const beforeRevisions = h.db.prepare("SELECT * FROM preparation_material_revisions ORDER BY id").all();
    const { request, snapshot } = await executePreparation(h);
    const bounded = request.userMessage.match(/<bounded_preparation_context>\s*([\s\S]*?)\s*<\/bounded_preparation_context>/)?.[1];
    assert.ok(bounded?.includes(RECORDED_STORY.content), "Full source body, not just its ID, reaches the model request builder");
    assert.ok(request.userMessage.includes(OWN_FAILURE_QUERY));
    assert.doesNotMatch(request.userMessage, /FORBIDDEN_/);
    assert.match(request.systemPrompt ?? "", /descriptive retrieval groups, not fact authority/);
    assert.match(request.systemPrompt ?? "", /Assistant history is only conversation context, never evidence/);
    assert.match(request.systemPrompt ?? "", /Never invent a personal experience/);
    const ref = snapshot.sourceRefs.find((source) => source.id === RECORDED_STORY.id);
    assert.equal(ref?.purpose, "personal-context");
    assert.equal(ref?.kmbEntryRevision, RECORDED_STORY.contentRevision);
    assert.equal(ref?.selectedChars, RECORDED_STORY.content.length);
    assert.equal(ref?.truncated, false);
    assert.equal(snapshot.budget.selectedKmbEntries, 3);
    assert.equal(snapshot.budget.selectedMaterialChunks, 6);
    assert.deepEqual(snapshot.retrieval?.pools.map((pool) => [pool.selectedMaterialChunks, pool.selectedKmbEntries]), [[3, 1], [3, 2]]);
    assert.ok(snapshot.budget.kmbChars <= 4000 && snapshot.budget.materialChars <= 8000);
    assert.ok(snapshot.budget.totalChars <= 30000 && (bounded?.length ?? Infinity) <= 30000);
    assert.deepEqual([...request.userMessage.matchAll(/\[K(\d+)\]/g)].map((match) => match[1]), ["1", "2", "3"]);
    assert.deepEqual([...request.userMessage.matchAll(/\[M(\d+)\]/g)].map((match) => match[1]), ["1", "2", "3", "4", "5", "6"]);
    assert.deepEqual(h.queries.map((query) => [query.preparationPurpose, query.query]), [
      ["guidance", BASE_REQUEST.query], ["personal-context", BASE_REQUEST.query],
    ]);
    assert.deepEqual(h.memory, beforeMemory);
    assert.deepEqual(h.db.prepare("SELECT * FROM preparation_source_refs ORDER BY id").all(), beforeSources);
    assert.deepEqual(h.db.prepare("SELECT * FROM preparation_material_revisions ORDER BY id").all(), beforeRevisions);
  } finally { h.close(); }
});

test("PM-D3 profile/preference/template discovery preserves runtime roles and no-source fact limits", async () => {
  const h = await preparationPurposeFixture();
  try {
    h.memory.push(...(["profile", "preference", "answer_template"] as const).map((type) => memoryEntry(type, type, {
      title: "failure", keywords: ["failure"], useCases: ["behavioral_interview"], content: `Failure ${type} reference.`,
    })));
    for (const purpose of ["guidance", "personal-context"] as const) {
      const result = await h.retrieveKmb({ ...BASE_REQUEST, preparationPurpose: purpose });
      assert.ok(result.entries.length > 0);
      for (const item of result.entries) {
        assert.deepEqual(item.runtimeRole, classifyRuntimeMemoryRole(item.entry));
        assert.equal(item.runtimeRole?.anchorEligible, false);
      }
    }
    const { request, snapshot } = await executePreparation(h, "quartz crystal lattice");
    assert.deepEqual(snapshot.sourceRefs, []);
    assert.match(request.systemPrompt ?? "", /profiles and preferences are not automatically fact anchors/);
    assert.match(request.systemPrompt ?? "", /Templates remain expression guidance/);
    assert.match(request.systemPrompt ?? "", /this request's sources do not support another example/);
    assert.doesNotMatch(request.userMessage, /<curated_memory_evidence>/);
  } finally { h.close(); }
});

test("PM-D4 expanded discovery retains both-pool quotas, borrowing, character caps and deterministic composition", async () => {
  for (const purposes of [["guidance"], ["personal-context"], ["guidance", "personal-context"]] as const) {
    for (const oversized of [false, true]) {
      const h = await preparationPurposeFixture();
      try {
        for (const purpose of purposes) {
          for (const suffix of ["a", "b"]) {
            await h.material(`${purpose}-${suffix}`, purpose, { chunks: 3, content: "failure " + "material ".repeat(oversized ? 2000 : 10) });
          }
          h.memory.push(...[0, 1, 2, 3].map((i) => memoryEntry(`${purpose}-${i}`, purpose === "guidance" ? "interview_framework" : "personal_story", {
            title: "failure", keywords: ["failure"], useCases: ["behavioral_interview"],
            scope: "project", projectId: "undisclosed", content: "failure " + "memory ".repeat(oversized ? 2000 : 10),
          })));
        }
        const lease = await h.conversations.beginRequest({ processId: "p", conversationId: h.conversation.id, content: OWN_FAILURE_QUERY });
        const input = { process: h.process, lease, messages: [] };
        const first = await composer(h).compose(input);
        const second = await composer(h).compose(input);
        assert.deepEqual(second, first);
        assert.equal(first.budget.selectedKmbEntries, 3);
        assert.ok(first.budget.selectedMaterialChunks > 0 && first.budget.selectedMaterialChunks <= 6);
        if (!oversized) assert.equal(first.budget.selectedMaterialChunks, 6);
        assert.ok(first.budget.kmbChars <= 4000 && first.budget.materialChars <= 8000 && first.budget.totalChars <= 30000);
        assert.ok(first.systemContext.length <= 30000);
        assert.equal(first.sourceRefs.some((ref) => ref.truncated), oversized);
        for (const purpose of purposes) {
          assert.ok(first.sourceRefs.some((ref) => ref.kind === "material" && ref.purpose === purpose));
          assert.ok(first.sourceRefs.some((ref) => ref.kind === "kmb" && ref.purpose === purpose));
        }
        if (purposes.length === 2) {
          assert.deepEqual(first.retrieval?.pools.map((pool) => pool.selectedKmbEntries), [1, 2]);
          if (!oversized) assert.deepEqual(first.retrieval?.pools.map((pool) => pool.selectedMaterialChunks), [3, 3]);
        }
      } finally { h.close(); }
    }
  }
});

test("PM-D1/D4 local cost observation on the same expanded candidate data", async (t) => {
  const h = await preparationPurposeFixture();
  try {
    h.memory.push(...Array.from({ length: 144 }, (_, i) => ({ ...structuredClone(RECORDED_STORY), id: `cost-story-${i}` })));
    const requests: Record<string, MemoryRetrievalRequest> = {
      meetingBoundary: BASE_REQUEST,
      preparationDiscovery: { ...BASE_REQUEST, preparationPurpose: "personal-context" },
    };
    const samples: Record<string, number[]> = { meetingBoundary: [], preparationDiscovery: [] };
    for (let i = 0; i < 45; i++) {
      const ordered = Object.entries(requests);
      if (i % 2) ordered.reverse();
      for (const [name, request] of ordered) {
        const result = await h.retrieveKmb(request);
        assert.equal(result.candidateCount, 144);
        assert.equal(result.eligibleCount, request.preparationPurpose ? 144 : 0);
        assert.ok(result.entries.length <= 3 && result.totalChars <= 4000);
        assert.ok(result.performance);
        if (i >= 5) samples[name].push(result.performance.totalMs);
      }
    }
    const timing = Object.fromEntries(Object.entries(samples).map(([name, values]) => {
      values.sort((a, b) => a - b);
      return [name, { medianMs: values[20].toFixed(3), p95Ms: values[37].toFixed(3) }];
    }));
    t.diagnostic(`Synthetic 144-story snapshot, 40 paired warm samples; includes fixture cloning, excludes DB/model I/O: ${JSON.stringify(timing)}`);
  } finally { h.close(); }
});
