import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { CURATED_MEMORY_DRAFT_PATHS } from "../src/lib/memory/curated-draft-paths.js";
import { parseCuratedMemoryDrafts } from "../src/lib/memory/parser.js";
import { buildMemoryEntryCandidate } from "../src/lib/memory/persistence.js";
import { getSharedMemoryRetrievalRuntime } from "../src/lib/memory/retrieval-runtime.js";
import { classifyRuntimeMemoryRole } from "../src/lib/memory/runtime-role.js";
import type { retrieveMemoryContext } from "../src/lib/memory/retrieval.js";
import type { MemoryEntry, MemoryRetrievalRequest, MemoryRetrievalResult } from "../src/lib/memory/types.js";
import { getProjectSelectionCapability, resolveProjectBinding } from "../src/lib/meeting/project-binding.js";
import { settleMemoryContextForProjectBinding } from "../src/lib/meeting/project-memory-settlement.js";
import { buildFactAnchorDecision } from "../src/lib/meeting/fact-anchor-guardrail.js";

const request: MemoryRetrievalRequest = {
  sessionId: "pd-fixture", query: "Which project are you most familiar with, and what was your personal contribution?",
  currentQuestionQuery: "Which project are you most familiar with, and what was your personal contribution?",
  questionType: "project-deep-dive", useCase: "project_deep_dive", askFrame: "past-project",
};
const drafts = CURATED_MEMORY_DRAFT_PATHS.map((path) => ({ path, content: readFileSync(path, "utf8") }));
const curated = parseCuratedMemoryDrafts(drafts).flatMap((draft) => draft.entries);

test("PD1 actual current-revision loader discovers all trusted identities before body gates and budgets", async (t) => {
  const h = await fixture();
  try {
    for (const entry of curated) h.store(entry);
    h.store(entry("old-revision", { projectId: "obsolete", projectName: "Obsolete" }));
    h.store(entry("old-revision", { projectId: "current", projectName: "Current" }));
    for (const [id, overrides] of [
      ["disabled", { enabled: false }], ["uncurated", { curationStatus: "raw" }],
      ["manual", { injectionMode: "manual_only" }], ["never", { injectionMode: "never" }],
      ["template", { type: "answer_template", evidenceEntryIds: ["fake-id"] }],
      ["overlay", { type: "whiteboard_overlay" }], ["guidance", { type: "interview_framework" }],
      ["empty", { content: " " }],
    ] as Array<[string, Partial<MemoryEntry>]>) h.store(entry(id, { projectId: id, projectName: id, ...overrides }));

    const small = await h.retrieve({ ...request, memoryStage: "candidate-discovery", maxEntries: 1, maxChars: 1 });
    const large = await h.retrieve({ ...request, memoryStage: "candidate-discovery", maxEntries: 99, maxChars: 100000,
      useCase: "coding_interview", questionType: "coding", memoryPolicy: { id: "block-all-body", allowedFamilies: ["coding"] } });
    const directory = small.projectDirectory!;
    assert.equal(directory.status, "ready");
    assert.deepEqual(directory.candidates, large.projectDirectory?.candidates);
    const filteredBody = await h.retrieve({ ...request, memoryStage: "prompt-injection", query: "unrelated", maxEntries: 1, maxChars: 1,
      useCase: "coding_interview", questionType: "coding", memoryPolicy: { id: "coding-only", allowedFamilies: ["coding"] } });
    assert.deepEqual(filteredBody.projectDirectory?.candidates, directory.candidates);
    assert.deepEqual(directory.candidates.map((c) => c.projectId).sort(), [
      "agentic_memory", "aos_release", "beaglestone_migration", "current", "managed_semantic_search",
      "ml_commons_platform_small_features", "model_interface", "neural_search", "oasis", "throttling",
    ]);
    assert.deepEqual(small.entries, []);
    assert.equal(small.contextText, "");
    assert.equal(h.runtime.getUsageQueueDepth(), 0);
    assert.equal(h.reads(), 1, "discovery reuses the effective snapshot");
    assert.equal(directory.snapshotVersion, small.performance?.snapshotVersion);
    assert.equal(directory.authorityRevision, small.performance?.authorityRevision);
    assert.equal(JSON.stringify(directory).includes("Concrete fixture evidence"), false, "directory contains no fact body");
    assert.equal(directory.rejectedEntries.find((e) => e.entryId === "template")?.reason, "not-fact-evidence");
    assert.equal(directory.rejectedEntries.find((e) => e.entryId === "disabled")?.reason, "disabled");
    t.diagnostic(`source entries=${curated.length}; directory cold=${small.performance?.projectDirectoryBuildMs?.toFixed(3)}ms warm=${large.performance?.projectDirectoryBuildMs?.toFixed(3)}ms; full cold=${small.performance?.totalMs.toFixed(3)}ms warm=${large.performance?.totalMs.toFixed(3)}ms`);
    const trace = JSON.parse(JSON.stringify(h.directoryTrace(directory)));
    assert.equal(trace.memoryProjectDirectorySnapshotVersion, directory.snapshotVersion);
    assert.deepEqual(trace.memoryProjectDirectoryCandidates, directory.candidates);
  } finally { h.close(); }
});

test("PD2 one/many, known/unknown, valid binding, empty/error/off and legacy body-only results have distinct capability", async () => {
  const h = await fixture();
  try {
    let memory = await h.retrieve({ ...request, memoryStage: "candidate-discovery" });
    assert.equal(capability(memory).reason, "no-eligible-evidence-project");
    h.store(entry("agentic", { projectId: "agentic_memory", projectName: "Agentic Memory", useCases: ["behavioral_interview"] }));
    h.runtime.invalidateSnapshot({ kind: "hard", reason: "fixture-publish" });
    memory = await h.retrieve({ ...request, memoryStage: "candidate-discovery" });
    const unbound = resolveProjectBinding({ ...request, memoryContext: memory });
    assert.equal(unbound.action, "needs-selection");
    assert.equal(unbound.binding, undefined);
    assert.equal(capability(memory).available, true);
    const known = resolveProjectBinding({ ...request, currentSourceText: "Explain your Agentic Memory project", memoryContext: memory });
    assert.equal(known.binding?.projectId, "agentic_memory");
    assert.equal(known.sourceAuthority, "interviewer-explicit");
    assert.equal(getProjectSelectionCapability({ decision: known, directory: memory.projectDirectory, memoryEnabled: true,
      questionType: "project-deep-dive", isActiveParent: true }).reason, "project-already-bound");
    const unknown = resolveProjectBinding({ ...request, currentSourceText: "Explain the Unknown project", memoryContext: memory });
    assert.equal(unknown.binding, undefined);
    assert.equal(capability(memory, unknown).available, false);
    assert.match(capability(memory, unknown).reason, /no-eligible-evidence-match/);
    const ambiguousHint = resolveProjectBinding({ ...request, projectAnchor: "Agentic", memoryContext: memory });
    assert.equal(ambiguousHint.binding, undefined);
    assert.equal(capability(memory, ambiguousHint).available, false);
    const idSpoof = resolveProjectBinding({ ...request, memoryContext: memory, explicitProjectSelection: {
      projectId: "agentic", projectName: "Agentic Memory", authority: "user-explicit", sessionId: "pd-fixture", runtimeEpoch: 1,
      sourceTurnId: "me", actionRevision: 1, createdAt: 1,
    } });
    assert.equal(idSpoof.binding, undefined, "unknown model project ID cannot fuzzy-match a known identity");
    assert.equal(resolveProjectBinding({ ...request, memoryContext: memory, existingBinding: known.binding,
      explicitProjectSelection: "Agentic" }).action, "invalidate", "partial identity cannot preserve a different explicit choice");
    const preserve = resolveProjectBinding({ ...request, memoryContext: memory, existingBinding: known.binding });
    assert.equal(preserve.action, "preserve");
    assert.equal(preserve.binding?.projectId, "agentic_memory");
    assert.equal(getProjectSelectionCapability({ decision: unbound, directory: memory.projectDirectory, memoryEnabled: false,
      questionType: "project-deep-dive", isActiveParent: true }).reason, "memory-disabled");
    assert.equal(getProjectSelectionCapability({ decision: unbound, directory: memory.projectDirectory, memoryEnabled: true,
      questionType: "project-deep-dive", isActiveParent: false }).available, false);
    const legacy = { ...memory, projectDirectory: undefined, entries: [{ entry: entry("legacy"), score: 100, matchReason: [], injectedContent: "legacy" }] };
    assert.equal(resolveProjectBinding({ ...request, memoryContext: legacy }).candidates.length, 0, "body results are no longer directory authority");
    h.failReads();
    h.runtime.invalidateSnapshot({ kind: "hard", reason: "fixture-failure" });
    const failed = await h.retrieve({ ...request, memoryStage: "candidate-discovery" });
    assert.equal(capability(failed).reason, "project-directory-unavailable");
    assert.match(failed.projectDirectory?.degradedReason ?? "", /fixture-read-failure/);
  } finally { h.close(); }
});

test("PD6 disabled current evidence closes discovery and remains excluded after binding", async () => {
  const h = await fixture();
  try {
    h.store(entry("trusted"));
    const discovery = await h.retrieve({ ...request, memoryStage: "candidate-discovery" });
    const binding = resolveProjectBinding({ ...request, memoryContext: discovery, explicitProjectSelection: "fixture" });
    assert.equal(binding.binding?.projectId, "fixture");
    await h.setEnabled("trusted", false);
    const current = await h.retrieve({ ...request, memoryStage: "candidate-discovery" });
    assert.equal(current.projectDirectory?.status, "ready");
    assert.deepEqual(current.projectDirectory?.candidates, []);
    assert.ok(current.projectDirectory!.authorityRevision > discovery.projectDirectory!.authorityRevision);
    assert.equal(capability(current).available, false);
    assert.equal(resolveProjectBinding({ ...request, memoryContext: current, explicitProjectSelection: "fixture" }).binding, undefined);
    const facts = await h.retrieve({ ...request, projectId: "fixture", projectAnchor: "Fixture" });
    assert.deepEqual(facts.entries, []);
    const preserve = resolveProjectBinding({ ...request, memoryContext: current, existingBinding: binding.binding });
    assert.equal(preserve.action, "preserve", "loss of facts does not reinterpret identity as a new choice");
    assert.equal(capability(current, preserve).reason, "project-already-bound");
  } finally { h.close(); }
});

test("PD3 imgnsq source drafts -> discovery -> user binding -> actual authorized retrieval and prompt context", async (t) => {
  const h = await fixture();
  try {
    for (const item of curated) h.store(item);
    const discovery = await h.retrieve({ ...request, memoryStage: "candidate-discovery", maxEntries: 1 });
    assert.equal(capability(discovery).available, true);
    assert.ok(discovery.projectDirectory?.candidates.some((c) => c.projectId === "agentic_memory"));
    const binding = resolveProjectBinding({ ...request, memoryContext: discovery, explicitProjectSelection: {
      projectId: "agentic_memory", projectName: "Agentic Memory", authority: "user-explicit", sessionId: "pd-fixture",
      runtimeEpoch: 1, sourceTurnId: "button-or-me-selection", actionRevision: 1, createdAt: 1,
    } });
    assert.equal(binding.action, "bind");
    const retrieved = await h.retrieve({ ...request, memoryStage: "prompt-injection", projectId: binding.binding!.projectId,
      projectAnchor: binding.binding!.projectName, memoryPolicy: { id: "bound-pdd", strictProjectAnchor: binding.binding!.projectId } });
    const settled = settleMemoryContextForProjectBinding({ candidateContext: retrieved, bindingDecision: binding });
    const facts = settled.memoryContext!.entries.filter((item) => classifyRuntimeMemoryRole(item.entry).anchorEligible);
    assert.ok(facts.length > 0);
    assert.ok(facts.every((item) => item.entry.projectId === "agentic_memory"));
    assert.match(settled.memoryContext!.contextText, /Agentic Memory/);
    assert.ok(facts.some((item) => settled.memoryContext!.contextText.includes(item.injectedContent)));
    assert.equal(retrieved.projectDirectory?.snapshotVersion, discovery.projectDirectory?.snapshotVersion);
    const anchors = buildFactAnchorDecision({ questionType: "project-deep-dive", questionText: request.query,
      memoryContext: settled.memoryContext, projectBindingDecision: binding });
    assert.equal(anchors.state, "strong-anchor");
    assert.ok(anchors.supportedAnchorIds.length > 0);
    assert.ok(anchors.supportedAnchorIds.every((id) => facts.some((fact) => fact.entry.id === id)));
    t.diagnostic(`imgnsq selected facts=${facts.map((fact) => fact.entry.id).join(",")}; supported anchors=${anchors.supportedAnchorIds.join(",")}; anchor state=${anchors.state}`);
    const discoveryAnchors = buildFactAnchorDecision({ questionType: "project-deep-dive", questionText: request.query,
      memoryContext: discovery, projectBindingDecision: binding });
    assert.deepEqual(discoveryAnchors.supportedAnchorIds, [], "discovery evidence IDs are not claim support");

    const evidence = curated.find((item) => item.id === "mem_agentic_memory_commit_evidence")!;
    assert.deepEqual(evidence.useCases, ["behavioral_interview", "project_deep_dive", "answer_alignment"]);
    const contributionRequest = { ...request, projectId: "agentic_memory", projectAnchor: "Agentic Memory",
      query: "Agentic Memory commit evidence memory APIs remote retry thread context",
      currentQuestionQuery: "Agentic Memory commit evidence memory APIs remote retry thread context",
      memoryPolicy: { id: "contribution", strictProjectAnchor: "agentic_memory" } } satisfies MemoryRetrievalRequest;
    const corrected = await h.retrieve(contributionRequest);
    assert.ok(corrected.entries.some((item) => item.entry.id === evidence.id));
    assert.match(corrected.contextText, /974b41877/);
    h.store({ ...evidence, useCases: ["behavioral_interview", "answer_alignment"] });
    h.runtime.invalidateSnapshot({ kind: "hard", reason: "reproduce-imgnsq-old-metadata" });
    const original = await h.retrieve(contributionRequest);
    assert.ok(original.projectDirectory?.candidates.some((c) => c.evidenceEntryIds.includes(evidence.id)));
    assert.ok(!original.entries.some((item) => item.entry.id === evidence.id));
    assert.ok(original.rejectSummary.some((reason) => reason.reason === "use-case-mismatch" && reason.sampleEntryIds.includes(evidence.id)));
    assert.ok(original.entries.some((item) => item.entry.evidenceEntryIds.includes(evidence.id)), "linked template/fact cannot exempt rejected evidence");
  } finally { h.close(); }
});

test("PD1/PD2 full directory resolves undisplayed projects and never uses ranking as authority", async () => {
  const h = await fixture();
  try {
    for (let i = 0; i < 12; i++) h.store(entry(`fact-${i}`, { projectId: `p-${i}`, projectName: `Distinct Project ${i}` }));
    const memory = await h.retrieve({ ...request, memoryStage: "candidate-discovery", maxEntries: 1 });
    assert.equal(capability(memory).candidates.length, 12);
    const decision = resolveProjectBinding({ ...request, currentSourceText: "Explain Distinct Project 11", memoryContext: memory });
    assert.equal(decision.binding?.projectId, "p-11");
  } finally { h.close(); }
});

test("PD3 bound facts retain use-case/family/manual/curation and cross-project gates, including global identities", async () => {
  const h = await fixture();
  try {
    for (const [id, overrides] of [
      ["allowed", {}], ["usecase", { useCases: ["coding_interview"] }],
      ["family", { interviewFamilies: ["coding"] }], ["manual", { injectionMode: "manual_only" }],
      ["uncurated", { curationStatus: "raw" }],
      ["wrong-global-fact", { type: "resume_fact", scope: "global", projectId: "wrong", projectName: "Wrong" }],
    ] as Array<[string, Partial<MemoryEntry>]>) h.store(entry(id, overrides));
    const result = await h.retrieve({ ...request, projectId: "fixture", projectAnchor: "Fixture",
      memoryPolicy: { id: "strict", strictProjectAnchor: "fixture" } });
    assert.deepEqual(result.entries.map((item) => item.entry.id), ["allowed"]);
    assert.ok(result.projectDirectory?.candidates.some((c) => c.projectId === "wrong"));
  } finally { h.close(); }
});

function capability(memory: MemoryRetrievalResult, decision = resolveProjectBinding({ ...request, memoryContext: memory })) {
  return getProjectSelectionCapability({ decision, directory: memory.projectDirectory, memoryEnabled: true,
    questionType: "project-deep-dive", isActiveParent: true });
}

function entry(id: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id, sourceIds: [], type: "project_context", title: "Fixture evidence", content: "Concrete fixture evidence.",
    scope: "project", projectId: "fixture", projectName: "Fixture", tags: [], keywords: [], priority: "normal", enabled: true,
    injectionMode: "retrieval", useCases: ["project_deep_dive"], confidentiality: "normal", curationStatus: "curated",
    relatedEntryIds: [], evidenceEntryIds: [], createdAt: 1, updatedAt: 1, ...overrides };
}

let instance = 0;
async function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const match of readFileSync("src-tauri/src/db/main.rs", "utf8").matchAll(/include_str!\("migrations\/([^"]+)"\)/g)) {
    db.exec(readFileSync(`src-tauri/src/db/migrations/${match[1]}`, "utf8"));
  }
  const runtime = getSharedMemoryRetrievalRuntime();
  runtime.resetForTests();
  let reads = 0, fail = false;
  const database = {
    async select(sql: string, values: SQLInputValue[] = []) {
      reads++;
      if (fail) throw new Error("fixture-read-failure");
      return db.prepare(sql).all(...values);
    },
    async execute(sql: string, values: SQLInputValue[] = []) { return db.prepare(sql).run(...values); },
  };
  const key = `__pdFixture${++instance}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[key] = { database };
  const url = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
  const configUrl = url(`export const getDatabase = async () => globalThis.${key}.database;`);
  const forbiddenUrl = url("export const invoke = () => { throw Error('Native operations forbidden'); }; export const CURATED_MEMORY_DRAFTS = [];");
  const dbUrl = url(stripTypeScriptTypes(readFileSync("src/lib/database/memory.action.ts", "utf8")) + `\n// ${key}`);
  const retrieveUrl = url(stripTypeScriptTypes(readFileSync("src/lib/memory/retrieval.ts", "utf8")) + `\n// ${key}`);
  const hooks = registerHooks({ resolve(specifier, context, next) {
    const resolved = context.parentURL === dbUrl && specifier === "./config" ? configUrl
      : context.parentURL === dbUrl && ["@tauri-apps/api/core", "@/lib/memory/curated-drafts"].includes(specifier) ? forbiddenUrl
      : context.parentURL === dbUrl && specifier.startsWith("@/lib/memory/") ? new URL(`../src/lib/memory/${specifier.slice("@/lib/memory/".length)}.js`, import.meta.url).href
      : context.parentURL === retrieveUrl && specifier === "@/lib/database/memory.action" ? dbUrl
      : context.parentURL === retrieveUrl && specifier.startsWith("./") ? new URL(`../src/lib/memory/${specifier.slice(2)}${specifier.endsWith(".js") ? "" : ".js"}`, import.meta.url).href
      : undefined;
    return resolved ? { url: resolved, shortCircuit: true } : next(specifier, context);
  } });
  const retrieval = await import(retrieveUrl) as typeof import("../src/lib/memory/retrieval.js");
  const databaseActions = await import(dbUrl) as typeof import("../src/lib/database/memory.action.js");
  const retrieve = retrieval.retrieveMemoryContext as typeof retrieveMemoryContext;
  return { db, runtime, retrieve, directoryTrace: retrieval.formatMemoryProjectDirectoryForTrace,
    setEnabled: databaseActions.setMemoryEntryEnabled, reads: () => reads, failReads: () => { fail = true; },
    store(input: MemoryEntry) {
      const candidate = buildMemoryEntryCandidate(input);
      db.prepare("INSERT OR IGNORE INTO memory_entries (id, enabled, created_at, updated_at, current_content_revision) VALUES (?, ?, 1, 1, NULL)").run(input.id, Number(input.enabled));
      const { revision } = db.prepare("SELECT COALESCE(MAX(revision), 0)+1 AS revision FROM memory_entry_revisions WHERE entry_id=?").get(input.id) as { revision: number };
      const fields = Object.keys(candidate.content);
      db.prepare(`INSERT INTO memory_entry_revisions (entry_id, revision, content_hash, source_revisions_json, created_at, ${fields.join(",")}) VALUES (?, ?, ?, '{}', 1, ${fields.map(() => "?").join(",")})`)
        .run(input.id, revision, `fixture-${input.id}-${revision}`, ...Object.values(candidate.content));
      db.prepare("UPDATE memory_entries SET current_content_revision=?, enabled=? WHERE id=?").run(revision, Number(input.enabled), input.id);
    },
    close() { runtime.resetForTests(); hooks.deregister(); delete globals[key]; db.close(); },
  };
}
