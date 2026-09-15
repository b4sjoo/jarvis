import assert from "node:assert/strict";
import test from "node:test";
import { preparationPurposeFixture, memoryEntry } from "./helpers/preparation-purpose-fixture.js";
import { createPreparationContextComposer, tokenizePreparationQuery } from "../src/lib/preparation/context-composer.js";
import { createPreparationConversationExecutionService } from "../src/lib/preparation/conversation-execution.js";
import type { PreparationFetchResponse, PreparationFetchResponseEvents } from "../src/lib/preparation/context-types.js";
import { preparationMemoryPurpose } from "../src/lib/memory/preparation-purpose.js";
import { classifyRuntimeMemoryRole } from "../src/lib/memory/runtime-role.js";
import { AIResponseEventBuilder, type AIResponseTerminalInput } from "../src/lib/functions/ai-response-events.js";
import type { PreparationMessageContextSnapshot } from "../src/lib/preparation/conversation-types.js";

function builder() {
  return new AIResponseEventBuilder("fixture", { requestId: "q", executionPlanId: "q", modelId: "fixture", sessionId: "fixture",
    runtimeEpoch: 0, logicalQuestionUnitId: "q", logicalQuestionRevision: 1, attemptId: "q-1", attemptNumber: 1, maxAttempts: 1 });
}
async function* queryEvents(text = '{"guidance":"iterate principle","personal-context":"experiment alternative"}', failure?: AIResponseTerminalInput) {
  const b = builder();
  b.observeProviderMetadata({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  if (!failure) yield b.content(text);
  yield b.terminal(failure ?? { status: "success", retryable: false, completionSignal: "stream-eof" });
}
function execution(h: Awaited<ReturnType<typeof preparationPurposeFixture>>, options: {
  rewrite?: PreparationFetchResponseEvents;
  answer?: PreparationFetchResponse;
} = {}) {
  const service = createPreparationConversationExecutionService({
    conversations: h.conversations, interviewProcesses: h.interviewProcesses, materials: h.materialRepo,
    contextComposer: createPreparationContextComposer({ materials: h.contextRepo, materialInventory: h.materialRepo, retrieveKmb: h.retrieveKmb }),
    materialExtraction: { async inspect() { throw new Error("No extraction in text fixture"); }, async commitCloudImageText() { throw new Error("No OCR"); }, async commitRecoveredText() { throw new Error("No recovery"); }, async flagQuality() { throw new Error("No automatic promotion"); } },
    imageGateway: { async read() { throw new Error("No image"); }, async readVisuals() { throw new Error("No visual recovery"); } },
    fetchQueryResponseEvents: options.rewrite ?? (() => queryEvents()),
    fetchResponse: options.answer ?? (async function* () { yield "Answer from supplied sources."; }),
  });
  const run = (content = "Could another experience support this principle?") => service.execute({ processId: "p", conversationId: h.conversation.id, content,
    route: { status: "ready", selectedProvider: { provider: "fixture", variables: {} }, provider: { id: "fixture", name: "Fixture", curl: "unused" } as never, missingRequiredVariables: [], supportsVision: false } });
  return { service, run };
}
async function latestSnapshot(h: Awaited<ReturnType<typeof preparationPurposeFixture>>) {
  const detail = await h.conversations.load("p", h.conversation.id);
  return detail.messages.at(-1)?.contextSnapshot as PreparationMessageContextSnapshot;
}

test("PM-R1 migration/persistence preserve revisions, review, unlabelled inventory and manual access", async () => {
  const h = await preparationPurposeFixture();
  try {
    assert.equal((await h.materialRepo.get("legacy"))?.purpose, undefined);
    await h.material("review", undefined, { review: true });
    await h.material("plain");
    const before = h.db.prepare("SELECT * FROM preparation_material_revisions WHERE material_id='review'").get();
    const sourceBefore = h.db.prepare("SELECT * FROM preparation_source_refs WHERE material_id='review'").get();
    await h.materialRepo.updatePurpose({ id: "review", workspaceId: "p", purpose: "personal-context" });
    assert.equal((await h.materialRepo.get("review"))?.purpose, "personal-context");
    assert.equal((await h.materialRepo.get("review"))?.status, "needs-review");
    assert.deepEqual(h.db.prepare("SELECT * FROM preparation_material_revisions WHERE material_id='review'").get(), before);
    assert.deepEqual(h.db.prepare("SELECT * FROM preparation_source_refs WHERE material_id='review'").get(), sourceBefore);
    const base = { processId: "p", queryTokens: ["iterate"], preferredMaterialIds: [], limit: 300 };
    assert.deepEqual(await h.contextRepo.searchCandidates({ ...base, purpose: "personal-context" }), []);
    assert.equal((await h.contextRepo.searchCandidates({ ...base, preferredMaterialIds: ["review"] })).find((c) => c.materialId === "review")?.materialStatus, "needs-review");
    assert.equal((await h.contextRepo.searchCandidates(base)).some((c) => c.materialId === "plain"), true);
    assert.equal((await h.contextRepo.searchCandidates({ ...base, purpose: "guidance" })).length, 0);
    const { run } = execution(h, { rewrite: async function* () { throw new Error("Inventory must not rewrite"); } });
    await run("What materials can you see now?");
    assert.deepEqual((await latestSnapshot(h)).sourceRefs.map((r) => r.materialId).sort(), ["legacy", "plain", "review"]);
    assert.equal(h.queries.length, 0);
    await h.materialRepo.updatePurpose({ id: "review", workspaceId: "p" });
    assert.equal((await h.materialRepo.get("review"))?.purpose, undefined);
    await assert.rejects(h.materialRepo.updatePurpose({ id: "plain", workspaceId: "p", purpose: "both" as never }), /CHECK/);
    h.db.exec("UPDATE preparation_workspaces SET status='archived' WHERE id='p'");
    await assert.rejects(h.materialRepo.updatePurpose({ id: "plain", workspaceId: "p", purpose: "guidance" }), /writable/);
  } finally { h.close(); }
});

test("PM-R3 SQL query/scope/review/purpose filtering precedes candidate LIMIT", async () => {
  const h = await preparationPurposeFixture();
  try {
    await h.material("distractor", "guidance", { chunks: 301 });
    await h.material("personal", "personal-context");
    await h.material("wrong-round", "personal-context", { round: true });
    await h.material("needs-review", "personal-context", { review: true });
    await h.material("unlabelled");
    const input = { processId: "p", queryTokens: ["iterate"], preferredMaterialIds: [], limit: 1, purpose: "personal-context" as const };
    assert.deepEqual((await h.contextRepo.searchCandidates(input)).map((c) => c.materialId), ["personal"]);
    assert.deepEqual(await h.contextRepo.searchCandidates({ ...input, queryTokens: ["absentterm"] }), []);
    const ids = ["personal"];
    await h.materialRepo.updatePurpose({ id: "personal", workspaceId: "p", purpose: "guidance" });
    assert.equal((await h.contextRepo.searchCandidates({ ...input, purposeMaterialIds: ids }))[0]?.purpose, "personal-context");
    h.db.exec("UPDATE preparation_material_revisions SET review_status='needs-review' WHERE material_id='personal'");
    assert.deepEqual(await h.contextRepo.searchCandidates({ ...input, purposeMaterialIds: ids }), []);
    h.db.exec("UPDATE preparation_material_revisions SET review_status='approved' WHERE material_id='personal'; UPDATE preparation_materials SET status='deleted' WHERE id='personal'");
    assert.deepEqual(await h.contextRepo.searchCandidates({ ...input, purposeMaterialIds: ids }), []);
  } finally { h.close(); }
});

test("PM-R1/R4 KMB filter is before selection and includes pinned/always while absent filter preserves defaults", async () => {
  const h = await preparationPurposeFixture();
  try {
    h.memory.push(...Array.from({ length: 5 }, (_, i) => memoryEntry(`guide-${i}`, "interview_framework", { priority: "pinned", injectionMode: "always" })),
      ...Array.from({ length: 4 }, (_, i) => memoryEntry(`personal-${i}`, "personal_story", { priority: "pinned", injectionMode: "always" })),
      memoryEntry("disabled", "personal_story", { enabled: false }), memoryEntry("manual", "personal_story", { injectionMode: "manual_only" }));
    const base = { query: "iterate", useCase: "general_chat" as const, maxEntries: 3, maxChars: 4000 };
    const absent = await h.retrieveKmb(base);
    const explicitAbsent = await h.retrieveKmb({ ...base, preparationPurpose: undefined });
    assert.deepEqual(absent.entries, explicitAbsent.entries);
    assert.ok(absent.entries.length > 3, "legacy always/pinned semantics remain unchanged without optional filter");
    const personal = await h.retrieveKmb({ ...base, preparationPurpose: "personal-context" });
    assert.equal(personal.entries.length, 3);
    assert.ok(personal.entries.every((e) => e.entry.id.startsWith("personal-")));
    assert.ok(personal.rejectSummary.some((r) => r.reason === "preparation-purpose-mismatch"));
    assert.ok(personal.rejectSummary.some((r) => r.reason === "disabled"));
    assert.ok(personal.rejectSummary.some((r) => r.reason === "manual-or-never"));
    for (const type of ["profile", "preference"] as const) {
      const e = memoryEntry(type, type);
      assert.equal(preparationMemoryPurpose(e), "personal-context");
      assert.deepEqual(classifyRuntimeMemoryRole(e), { role: "guidance", anchorEligible: false, anchorEligibilityReason: `guidance-entry-type:${type}` });
    }
    assert.equal(preparationMemoryPurpose(memoryEntry("template", "answer_template")), "guidance");
    assert.equal(preparationMemoryPurpose(memoryEntry("unbound", "project_context")), "guidance");
    assert.equal(preparationMemoryPurpose(memoryEntry("bound", "project_context", { projectId: "project" })), "personal-context");
  } finally { h.close(); }
});

test("PM-R2/R4 actual history rewrite -> both stores by purpose -> final compact citations and persisted context", async () => {
  const h = await preparationPurposeFixture();
  try {
    await h.material("principle-guide", "guidance", { chunks: 5, content: "iterate principle experiment" });
    await h.material("experience", "personal-context", { chunks: 5, content: "experiment alternative" });
    await h.material("unlabelled", undefined, { chunks: 8 });
    h.memory.push(...[0, 1, 2].map((i) => memoryEntry(`guidance-${i}`, "interview_framework", { priority: "pinned", injectionMode: "always" })),
      ...[0, 1, 2].map((i) => memoryEntry(`experience-${i}`, "personal_story", { priority: "pinned", injectionMode: "always" })));
    await h.seedHistory("Oracle iterate principle and the previous experience.");
    let rewrites = 0, answers = 0;
    const { run } = execution(h, {
      rewrite: async function* (input) {
        rewrites++;
        assert.equal(input.requestOptions?.timeoutMs, 15000);
        assert.equal(input.requestOptions?.maxOutputTokens, 2048);
        assert.equal(input.requestOptions?.retryPolicy?.maxAttempts, 1);
        assert.match(JSON.stringify(input.history), /Oracle iterate/);
        assert.ok((input.history ?? []).reduce((n, m) => n + String(m.content).length, 0) <= 12000);
        yield* queryEvents();
      },
      answer: async function* (input) {
        answers++;
        assert.match(input.userMessage, /principle-guide/);
        assert.match(input.userMessage, /experience/);
        assert.doesNotMatch(input.userMessage, /unlabelled/);
        assert.match(input.systemPrompt ?? "", /descriptive retrieval groups, not fact authority/);
        assert.match(input.userMessage, /Could another experience/);
        assert.deepEqual([...input.userMessage.matchAll(/\[M(\d+)\]/g)].map((m) => m[1]), ["1", "2", "3", "4", "5", "6"]);
        assert.deepEqual([...input.userMessage.matchAll(/\[K(\d+)\]/g)].map((m) => m[1]), ["1", "2", "3"]);
        yield "Use only sourced experience; this fixture does not prove model semantics.";
      },
    });
    await run();
    assert.equal(rewrites, 1); assert.equal(answers, 1);
    assert.deepEqual(h.queries.map((q) => [q.preparationPurpose, q.query]), [["guidance", "iterate principle"], ["personal-context", "experiment alternative"]]);
    const snapshot = await latestSnapshot(h);
    assert.equal(snapshot.retrieval?.disposition, "rewritten");
    assert.equal(snapshot.retrieval?.tokenUsage?.outputTokens, 20);
    assert.equal(snapshot.retrieval?.historyMessageIds.length, 2);
    assert.equal(snapshot.budget.selectedMaterialChunks, 6);
    assert.equal(snapshot.budget.selectedKmbEntries, 3);
    assert.deepEqual(snapshot.retrieval?.pools.map((p) => [p.selectedMaterialChunks, p.selectedKmbEntries]), [[3, 1], [3, 2]]);
    assert.ok(snapshot.sourceRefs.every((ref) => ref.purpose));
    assert.ok(snapshot.sourceRefs.filter((ref) => ref.kind === "kmb").every((ref) => ref.kmbEntryRevision === 1));
  } finally { h.close(); }
});

test("PM-R4 empty capacity is borrowed and rendered budgets remain bounded with oversized content", async () => {
  const h = await preparationPurposeFixture();
  try {
    await h.material("personal-a", "personal-context", { chunks: 3, content: "iterate " + "x".repeat(10000) });
    await h.material("personal-b", "personal-context", { chunks: 3, content: "iterate " + "y".repeat(10000) });
    h.memory.push(...[0, 1, 2, 3, 4].map((i) => memoryEntry(`pinned-${i}`, "profile", { priority: "pinned", injectionMode: "always", content: "z".repeat(10000) })));
    const { run } = execution(h);
    await run("iterate");
    const s = await latestSnapshot(h);
    assert.equal(s.budget.selectedKmbEntries, 3);
    assert.ok(s.budget.materialChars <= 8000); assert.ok(s.budget.kmbChars <= 4000); assert.ok(s.budget.totalChars <= 30000);
    assert.ok(s.sourceRefs.every((r) => r.purpose === "personal-context"));
    assert.ok(s.sourceRefs.some((r) => r.truncated));
  } finally { h.close(); }
});

test("PM-R5 labels are captured before rewrite; review/deletion/scope remain current at SQL retrieval", async () => {
  const h = await preparationPurposeFixture();
  try {
    await h.material("changing", "personal-context"); await h.material("reviewed", "personal-context"); await h.material("deleted", "personal-context"); await h.material("moved", "personal-context");
    await h.seedHistory("iterate");
    const { run } = execution(h, { rewrite: async function* () {
      await h.materialRepo.updatePurpose({ id: "changing", workspaceId: "p", purpose: "guidance" });
      h.db.exec("UPDATE preparation_material_revisions SET review_status='needs-review' WHERE material_id='reviewed'; UPDATE preparation_materials SET status='deleted' WHERE id='deleted'; UPDATE preparation_materials SET scope_kind='round',scope_id='other-round' WHERE id='moved'");
      yield* queryEvents();
    } });
    await run();
    assert.deepEqual((await latestSnapshot(h)).sourceRefs.map((r) => [r.materialId, r.purpose]), [["changing", "personal-context"]]);
    await execution(h).run("iterate");
    assert.deepEqual((await latestSnapshot(h)).sourceRefs.map((r) => [r.materialId, r.purpose]), [["changing", "guidance"]]);
  } finally { h.close(); }
});

for (const failure of ["format", "transport", "authentication", "configuration", "cancel", "stale"] as const) {
  test(`PM-R5 composed rewrite ${failure}: no retry and no stale/auth fallback`, async () => {
    const h = await preparationPurposeFixture();
    try {
      await h.seedHistory("iterate");
      let rewrites = 0, answers = 0;
      const e = execution(h, {
        rewrite: async function* () {
          rewrites++;
          if (failure === "cancel") e.service.cancel();
          if (failure === "stale") h.db.exec("UPDATE preparation_conversations SET active_operation_id='another',revision=revision+1");
          if (failure === "format") yield* queryEvents("bad JSON");
          else if (["transport", "authentication", "configuration"].includes(failure)) {
            yield* queryEvents("", { status: "failed", failureClass: failure as "transport" | "authentication" | "configuration", retryable: false, safeErrorSummary: `fixture ${failure}` });
          } else yield* queryEvents();
        },
        answer: async function* () { answers++; yield "Fallback answer"; },
      });
      if (failure === "cancel" || failure === "authentication" || failure === "configuration") await assert.rejects(e.run(), /cancelled|fixture/);
      else if (failure === "stale") assert.equal((await e.run()).status, "stale");
      else {
        await e.run("original iterate query");
        const s = await latestSnapshot(h);
        assert.equal(s.retrieval?.disposition, "fallback");
        assert.deepEqual(h.queries.map((q) => q.query), ["original iterate query", "original iterate query"]);
      }
      assert.equal(rewrites, 1);
      assert.equal(answers, failure === "format" || failure === "transport" ? 1 : 0);
      if (!answers) assert.equal(h.queries.length, 0);
    } finally { h.close(); }
  });
}

test("generic Preparation CJK/Latin boundaries preserve technical identifiers", () => {
  for (const token of ["story", "iterate", "project"]) assert.ok(tokenizePreparationQuery("如果这个story没有iterate细节的话你能再看看我别的project有没有合适的吗？").includes(token));
  const technical = tokenizePreparationQuery("比较C++与C#还有.NET、foo_bar、BM25及OAuth2的API设计");
  for (const token of ["c++", "c#", "foo_bar", "bm25", "oauth2", "api"]) assert.ok(technical.includes(token), token);
});

test("PM-R3 explicit changed topic consumes the new queries and never locks the old principle", async () => {
  const h = await preparationPurposeFixture();
  try {
    await h.material("old-principle", "guidance", { content: "iterate" });
    await h.material("new-principle", "guidance", { content: "customer" });
    await h.material("new-experience", "personal-context", { content: "customer" });
    h.memory.push(memoryEntry("old-memory", "interview_framework", { title: "iterate", keywords: ["iterate"], content: "iterate" }),
      memoryEntry("new-memory", "interview_framework", { title: "customer", keywords: ["customer"], content: "customer" }));
    await h.seedHistory("iterate");
    await execution(h, { rewrite: async function* () { yield* queryEvents('{"guidance":"customer","personal-context":"customer"}'); } }).run("Switch explicitly to a new principle.");
    const s = await latestSnapshot(h);
    assert.deepEqual(s.sourceRefs.map((r) => r.materialId ?? r.id).sort(), ["new-experience", "new-memory", "new-principle"]);
    assert.equal(s.retrieval?.queries.guidance, "customer");
  } finally { h.close(); }
});

test("PM-R4 unused Material/KMB slots borrow in either direction, while both long pools retain sources", async () => {
  for (const purpose of ["guidance", "personal-context"] as const) {
    const h = await preparationPurposeFixture();
    try {
      await h.material("a", purpose, { chunks: 3 }); await h.material("b", purpose, { chunks: 3 });
      h.memory.push(...[0, 1, 2].map((i) => memoryEntry(`entry-${i}`, purpose === "guidance" ? "interview_framework" : "personal_story")));
      await execution(h).run("iterate experiment");
      const s = await latestSnapshot(h);
      assert.equal(s.budget.selectedMaterialChunks, 6);
      assert.equal(s.budget.selectedKmbEntries, 3);
      assert.ok(s.sourceRefs.every((r) => r.purpose === purpose));
      await h.material("other-pool", purpose === "guidance" ? "personal-context" : "guidance", { chunks: 3, content: "iterate experiment ".repeat(3000) });
      h.memory.push(memoryEntry("other-entry", purpose === "guidance" ? "personal_story" : "interview_framework", { content: "iterate ".repeat(3000) }));
      await execution(h).run("iterate");
      const both = await latestSnapshot(h);
      assert.ok(both.sourceRefs.some((r) => r.kind === "material" && r.purpose === "guidance"));
      assert.ok(both.sourceRefs.some((r) => r.kind === "material" && r.purpose === "personal-context"));
      assert.ok(both.sourceRefs.some((r) => r.kind === "kmb" && r.purpose === "guidance"));
      assert.ok(both.sourceRefs.some((r) => r.kind === "kmb" && r.purpose === "personal-context"));
      assert.ok(both.budget.materialChars <= 8000 && both.budget.kmbChars <= 4000 && both.budget.totalChars <= 30000);
    } finally { h.close(); }
  }
});

test("PM-R5 15s deadline falls back once even if the query provider ignores abort", async (t) => {
  const h = await preparationPurposeFixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  try {
    await h.seedHistory("iterate");
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let started!: () => void;
    const beginning = new Promise<void>((resolve) => { started = resolve; });
    let count = 0;
    const { run } = execution(h, { rewrite: async function* () { count++; started(); await blocked; yield* queryEvents(); } });
    const request = run("original iterate");
    await beginning;
    t.mock.timers.tick(15000);
    await request;
    const s = await latestSnapshot(h);
    assert.equal(s.retrieval?.disposition, "fallback");
    assert.equal(s.retrieval?.durationMs, 15000);
    assert.match(s.retrieval?.failure ?? "", /timed out/);
    assert.equal(count, 1);
    assert.deepEqual(h.queries.map((q) => q.query), ["original iterate", "original iterate"]);
    release();
    await Promise.resolve();
    assert.equal((await latestSnapshot(h)).operationId, s.operationId);
  } finally { release(); t.mock.timers.reset(); h.close(); }
});

test("PM-R5 answer cancellation rejects late chunks after a successful composed rewrite", async () => {
  const h = await preparationPurposeFixture();
  try {
    await h.seedHistory("iterate");
    const e = execution(h, { answer: async function* () { yield "partial"; e.service.cancel(); yield "late completion"; } });
    await assert.rejects(e.run(), /cancelled/);
    const detail = await h.conversations.load("p", h.conversation.id);
    assert.equal(detail.messages.at(-1)?.role, "user");
    assert.equal(e.service.getSnapshot()?.partial, "partial");
    assert.equal(e.service.getSnapshot()?.status, "cancelled");
  } finally { h.close(); }
});

test("PM-R2 rewrite consumes only bounded history and historical refs never authorize review access", async () => {
  const h = await preparationPurposeFixture();
  try {
    await h.material("blocked-history-source", "personal-context", { review: true });
    for (let i = 0; i < 10; i++) await h.seedHistory(`turn-${i} ${i === 0 ? "old-excluded-marker" : "iterate"} ${"context ".repeat(180)}`);
    h.db.prepare("UPDATE preparation_messages SET source_refs_json=? WHERE role='assistant'").run(JSON.stringify([
      { kind: "material", id: "blocked-history-source-0", materialId: "blocked-history-source", materialRevisionId: "r-blocked-history-source", title: "blocked-history-source", selectedChars: 10, truncated: false },
    ]));
    let rewritten = 0;
    await execution(h, { rewrite: async function* (input) {
      rewritten++;
      assert.ok((input.history?.length ?? 0) <= 16);
      assert.ok((input.history ?? []).reduce((n, m) => n + String(m.content).length, 0) <= 12000);
      assert.doesNotMatch(JSON.stringify(input.history), /old-excluded-marker/);
      assert.doesNotMatch(input.userMessage, /generated_non_authoritative_summary|old-excluded-marker/);
      assert.match(input.userMessage, /blocked-history-source/);
      yield* queryEvents('{"guidance":"iterate","personal-context":"blocked-history-source"}');
    } }).run("Explain the current experience");
    assert.equal(rewritten, 1);
    const s = await latestSnapshot(h);
    assert.deepEqual(s.sourceRefs, []);
    assert.ok((s.retrieval?.historyMessageIds.length ?? 0) <= 16);
    assert.ok(s.budget.totalChars <= 30000);
  } finally { h.close(); }
});
