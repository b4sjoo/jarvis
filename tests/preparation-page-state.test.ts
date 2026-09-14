import assert from "node:assert/strict";
import test from "node:test";
import { createPreparationConversationService } from "../src/lib/preparation/conversation-service.js";
import type { PreparationConversationRepository } from "../src/lib/preparation/conversation-types.js";
import type { InterviewProcessRepository } from "../src/lib/preparation/interview-types.js";
import { deferred, elements, loadPreparationModules, PreparationHookHost, settle } from "./helpers/preparation-page-harness.js";

function processDetail(id: string, activeRoundId = `${id}-r1`) {
  return { process: { id, workspaceId: id, title: id, activeRoundId, status: "active", createdAt: 1, updatedAt: 1 },
    rounds: [1, 2].map((n) => ({ id: `${id}-r${n}`, processId: id, title: `Round ${n}`, stage: "coding" })) };
}
function session(id: string, processId = "A") {
  return { id, processId, scope: { kind: "process" }, title: id, revision: 1, createdAt: 1, updatedAt: 1 };
}
function material(id: string, status = "ready", updatedAt = 1) {
  return { id, workspaceId: "A", status, updatedAt, scope: { kind: "workspace" }, mimeType: "text/plain", displayName: id };
}
function fixture() {
  const calls: { name: string; args: any[] }[] = [];
  const queued = new Map<string, Promise<any>[]>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const sessions = new Map([ ["a1", session("a1")], ["a2", session("a2")], ["b1", session("b1", "B")] ]);
  let inventory: any[] = [material("m1"), material("m2")];
  let statementStatus = "proposed";
  let selectionListener: () => void = () => {};
  const wrap = (name: string, fallback: (...args: any[]) => any) => (...args: any[]) => {
    calls.push({ name, args });
    return queued.get(name)?.shift() ?? Promise.resolve().then(() => fallback(...args));
  };
  const repository = {
    getById: async (id: string) => sessions.get(id),
    listForProcess: async (id: string) => [...sessions.values()].filter((value) => value.processId === id),
    listMessages: async (id: string) => [{ id: `${id}-message`, conversationId: id, role: "user", content: `${id} history`, materialRefs: [], sourceRefs: [], createdAt: 1 }],
    insert: async (value: any) => { sessions.set(value.id, value); },
    updateMetadata: async (input: any) => { Object.assign(sessions.get(input.conversationId)!, { title: input.title, scope: input.scope }); return true; },
    deleteConversation: async (_process: string, id: string) => sessions.delete(id),
    countForRound: async () => 0,
  } as unknown as PreparationConversationRepository;
  let id = 0;
  const realConversation = createPreparationConversationService({ repository,
    interviewProcesses: { getProcess: async (id: string) => processDetail(id).process,
      getRound: async (id: string) => ({ id, processId: id.slice(0, 1) }) } as InterviewProcessRepository,
    createId: () => `created-${++id}`, now: () => 2 });
  const api = {
    process: { list: wrap("process.list", () => [processDetail("A").process, processDetail("B").process]), get: wrap("process.get", processDetail) },
    material: { list: wrap("material.list", (id: string) => id === "A" ? inventory : []) },
    extraction: {
      inspect: wrap("inspection", (_process: string, id: string) => ({ material: inventory.find((m) => m.id === id), candidate: { revisionId: `${id}-revision`, status: "ready", reviewStatus: "needs-review", qualitySignals: [] }, chunks: [], id })),
      resumeWorkspace: wrap("resume", () => undefined),
      commitManualText: wrap("manualText", () => undefined),
      approve: wrap("approve", () => true),
    },
    conversation: Object.fromEntries(Object.entries(realConversation).map(([name, method]) => [name, wrap(`conversation.${name}`, method)])),
    statement: {
      list: wrap("statements", ({ processId, roundId }: any) => [{ id: `${processId}:${roundId}`, processId, scope: roundId ? { kind: "round", roundId } : { kind: "process" }, revision: 3, status: statementStatus }]),
      listEvents: wrap("events", (_process: string, id: string) => [{ id }]), review: wrap("statement.review", (input: any) => { statementStatus = input.status; }),
    },
    composition: { getLatestProfile: wrap("profile", () => undefined), listNarratives: wrap("narratives", () => []), composeProfile: wrap("compose", () => ({ created: true, profile: { revision: 1 } })) },
    snapshot: {
      list: wrap("snapshots", () => []), getCurrentContext: wrap("context", () => ({ revision: 1, updatedAt: 1 })), getCurrentSnapshot: wrap("selected", () => undefined),
      compile: wrap("compile", (input: any) => ({ created: true, snapshot: { ...input, id: "snapshot-1", version: 1 } })),
      activate: wrap("activate", (input: any) => ({ ...input, id: input.snapshotId, version: 1 })),
    },
    subscribe: (listener: () => void) => { selectionListener = listener; return () => { selectionListener = () => {}; }; },
  };
  const executions: { input: any; result: ReturnType<typeof deferred> }[] = [];
  let executionSnapshot: any;
  let currentExecution: (typeof executions)[number] | undefined;
  const executionListeners = new Set<() => void>();
  const publishExecution = (snapshot: any) => { executionSnapshot = snapshot; executionListeners.forEach((listener) => listener()); };
  const preparation = {
    interviewPreparationService: api.process,
    interviewPreparationMaterialService: api.material,
    interviewPreparationMaterialExtractionService: api.extraction,
    interviewPreparationConversationService: api.conversation,
    interviewPreparationStatementService: api.statement,
    interviewPreparationCompositionService: api.composition,
    interviewPreparationSnapshotService: api.snapshot,
    interviewPreparationConversationExecutionService: {
      getSnapshot: () => executionSnapshot,
      subscribe: (listener: () => void) => { executionListeners.add(listener); return () => executionListeners.delete(listener); },
      cancel: () => {
        currentExecution?.input.controller.abort();
        publishExecution({ ...executionSnapshot, status: "cancelled" });
        currentExecution?.result.reject(new Error("cancelled"));
      },
      resolveRoute: () => ({ status: "ready" }), execute: (input: any) => {
        const result = deferred(), controller = new AbortController();
        const item = { input: { ...input, controller, signal: controller.signal, onDelta: (partial: string) => {
          if (currentExecution === item && !controller.signal.aborted) publishExecution({ ...executionSnapshot, partial });
        } }, result };
        currentExecution = item; executions.push(item);
        publishExecution({ processId: input.processId, conversationId: input.conversationId, status: "running", partial: "" });
        return result.promise.then((value: any) => {
          if (currentExecution === item) publishExecution({ ...executionSnapshot, status: value.status });
          return value;
        });
      },
    },
    interviewPreparationStatementProposalService: { resolveRoute: () => ({ status: "ready" }) },
    formatPreparationModelRouteError: () => "route error",
    createPreparationProfileSourceFingerprint: () => "fingerprint",
    materialsForActiveRound: (materials: any[]) => materials,
    formatPreparationMaterialScope: () => "Entire process",
    formatPreparationMaterialType: () => "Text",
    PREPARATION_STATEMENT_DOMAINS: [], PREPARATION_NARRATIVE_SUBJECT_KINDS: [],
    subscribe: api.subscribe,
  };
  const load = loadPreparationModules(preparation, timers);
  const { usePreparationData } = load("usePreparationData.ts");
  let processId = "A";
  const host = new PreparationHookHost(() => usePreparationData(processId, api));
  const panels: PreparationHookHost[] = [];
  const flush = () => settle([host, ...panels], () => {
    if (host.output !== lastData) { lastData = host.output; panels.forEach((panel) => { panel.dirty = true; }); }
  });
  let lastData: any;
  function mountPanel(name: string) {
    const Component = load(`components/${name}.tsx`)[name];
    const panel = new PreparationHookHost(() => Component({ data: host.output, detail: host.output.detail.data,
      processId, processStatus: "active", rounds: host.output.detail.data.rounds,
      materials: host.output.materials.data ?? [], currentContext: host.output.currentContext.data,
      onError: host.output.onError, onNotice: host.output.onNotice,
      onChanged: host.output.refreshMaterials, onMaterialsChanged: host.output.refreshMaterials,
      onCurrentContextChanged: host.output.refreshSelection,
      onExpandedChange: noop, onDetailViewChange: noop,
    }));
    panels.push(panel);
    return panel;
  }
  return { host, panels, calls, api, timers, executions, flush, mountPanel,
    get data() { return host.output; },
    selectProcess(id: string) { processId = id; host.dirty = true; },
    queue(name: string, ...promises: Promise<any>[]) { queued.set(name, [...(queued.get(name) ?? []), ...promises]); },
    count(name: string) { return calls.filter((call) => call.name === name).length; },
    setMaterials(value: any[]) { inventory = value; },
    setStatementStatus(value: string) { statementStatus = value; },
    selectionEvent() { selectionListener(); },
    cleanup() { panels.forEach((panel) => panel.unmount()); host.unmount(); },
  };
}
const noop = () => {};
const by = (host: PreparationHookHost, predicate: (node: any) => boolean) => {
  const node = elements(host.output).find(predicate);
  assert.ok(node, "Expected production UI consumer");
  return node.props;
};

test("P169-1 actual page hook: A slow/B fast/A again rejects old success, error and completion", async () => {
  const h = fixture();
  const a1 = deferred(), b = deferred(), a2 = deferred();
  h.queue("process.get", a1.promise, b.promise, a2.promise);
  await h.flush();
  h.selectProcess("B"); await h.flush();
  b.resolve(processDetail("B")); await h.flush();
  assert.equal(h.data.detail.data.process.id, "B");
  h.selectProcess("A"); await h.flush();
  assert.equal(h.data.detail.data, undefined);
  a1.resolve(processDetail("A", "obsolete")); await h.flush();
  assert.equal(h.data.detail.data, undefined);
  assert.equal(h.data.detail.loading, true);
  a2.resolve(processDetail("A")); await h.flush();
  assert.equal(h.data.detail.data.process.activeRoundId, "A-r1");
  assert.equal(h.data.detail.loading, false);
  const old = deferred(); h.queue("process.get", old.promise);
  void h.data.refreshProcess(); await h.flush();
  h.selectProcess("B"); await h.flush();
  old.reject(new Error("late A error")); await h.flush();
  assert.equal(h.data.error, undefined);
  assert.equal(h.data.detail.data.process.id, "B");
  h.cleanup();
});

test("P169-1/4 same-key mutation discards the old read and coalesces one follow-up without ending loading", async () => {
  const h = fixture(); await h.flush();
  const old = deferred(), fresh = deferred();
  h.queue("material.list", old.promise, fresh.promise);
  const before = h.count("material.list");
  void h.data.refreshMaterials(); await h.flush();
  void h.data.refreshMaterials(); void h.data.refreshMaterials(); await h.flush();
  assert.equal(h.count("material.list"), before + 1);
  old.resolve([material("old")]); await h.flush();
  assert.equal(h.data.materials.loading, true);
  assert.equal(h.data.materials.data[0].id, "m1");
  assert.equal(h.count("material.list"), before + 2);
  fresh.resolve([material("fresh")]); await h.flush();
  assert.equal(h.data.materials.data[0].id, "fresh");
  assert.equal(h.data.materials.loading, false);
  h.cleanup();
});

test("P169-2 real conversation service and page hook isolate session, inspection and review scope ABA", async () => {
  const h = fixture(); await h.flush();
  const first = deferred(), second = deferred();
  h.queue("conversation.load", first.promise, second.promise);
  h.data.selectConversation("a1"); await h.flush();
  h.data.selectConversation("a2"); await h.flush();
  second.resolve({ conversation: session("a2"), messages: [] }); await h.flush();
  first.reject(new Error("obsolete chat")); await h.flush();
  assert.equal(h.data.conversation.data.conversation.id, "a2");
  assert.equal(h.data.error, undefined);
  h.data.selectConversation("a1"); await h.flush();
  assert.equal(h.data.conversation.data.messages[0].content, "a1 history", "normal result passes real service validation");

  const inspect1 = deferred(), inspect2 = deferred(), inspect3 = deferred();
  h.queue("inspection", inspect1.promise, inspect2.promise, inspect3.promise);
  h.data.selectMaterial("m1"); await h.flush();
  h.data.selectMaterial("m2"); await h.flush();
  h.data.selectMaterial("m1"); await h.flush();
  inspect1.resolve({ id: "old m1" }); inspect2.reject(new Error("old m2")); await h.flush();
  assert.equal(h.data.inspection.data, undefined);
  assert.equal(h.data.inspection.loading, true);
  inspect3.resolve({ id: "new m1" }); await h.flush();
  assert.equal(h.data.inspection.data.id, "new m1");

  const review1 = deferred(), review2 = deferred();
  h.queue("statements", review1.promise, review2.promise);
  h.data.selectReviewScope("round:A-r2"); await h.flush();
  h.data.selectReviewScope("round:A-r1"); await h.flush();
  review1.resolve([{ id: "old round" }]); await h.flush();
  assert.equal(h.data.statements.data, undefined);
  review2.resolve([{ id: "current round" }]); await h.flush();
  assert.equal(h.data.statements.data[0].id, "current round");
  h.cleanup();
});

test("P169-3/7 actual Conversation and Reviewed consumers share sessions; 750ms polls preserve history and draft", async () => {
  const h = fixture(); h.setMaterials([material("m1", "extracting")]); await h.flush();
  const chat = h.mountPanel("PreparationConversationPanel");
  const review = h.mountPanel("ReviewedPreparationPanel"); await h.flush();
  assert.equal(h.count("conversation.list"), 1);
  assert.deepEqual([...h.timers.values()].map((timer) => timer.delay).sort((a, b) => a - b), [750, 5000]);
  h.data.selectConversation("a1"); await h.flush();
  by(chat, (n) => n.type === "Textarea").onChange({ target: { value: "unsaved draft" } }); await h.flush();
  const baseline = Object.fromEntries(["conversation.list", "conversation.load", "statements", "profile", "narratives", "snapshots", "context", "selected"].map((name) => [name, h.count(name)]));
  const pending = deferred(); h.queue("material.list", pending.promise);
  const poll = [...h.timers.values()].find((timer) => timer.delay === 750)!;
  const materialReads = h.count("material.list");
  for (let i = 0; i < 10; i++) { poll.callback(); await h.flush(); }
  assert.equal(h.count("material.list"), materialReads + 1, "polls do not overlap or enqueue reruns");
  const renderCounts = [h.host.renders, chat.renders, review.renders];
  pending.resolve([material("m1", "extracting", 2)]); await h.flush();
  assert.equal(h.data.selectedSessionId, "a1");
  assert.equal(by(chat, (n) => n.type === "Textarea").value, "unsaved draft");
  for (const [name, count] of Object.entries(baseline)) assert.equal(h.count(name), count, name);
  assert.deepEqual([h.host.renders, chat.renders, review.renders].map((count, i) => count - renderCounts[i]), [1, 1, 1], "one publication render, without a loading render or selection reset");
  assert.ok(elements(review.output).some((n) => n.type === "SelectItem" && n.props.value === "a1"));
  h.cleanup();
});

test("P169-2/3 Material consumer retains manual draft and original base revision across inspection refresh", async () => {
  const h = fixture();
  const image = { ...material("m1"), mimeType: "image/png", sizeBytes: 100 };
  h.setMaterials([image]); await h.flush();
  const panel = h.mountPanel("MaterialPanel"); await h.flush();
  h.data.selectMaterial("m1"); await h.flush();
  by(panel, (n) => n.type === "Button" && n.props.children?.includes?.("Edit extracted content")).onClick(); await h.flush();
  by(panel, (n) => n.type === "Textarea").onChange({ target: { value: "manual unsaved text" } }); await h.flush();
  h.queue("inspection", Promise.resolve({ candidate: { revisionId: "new-revision", status: "ready", reviewStatus: "needs-review", qualitySignals: [] }, chunks: [{ id: "chunk", content: "new backend content" }] }));
  h.setMaterials([{ ...image, updatedAt: 2 }]);
  await h.data.refreshMaterials(); await h.flush();
  assert.equal(by(panel, (n) => n.type === "Textarea").value, "manual unsaved text");
  by(panel, (n) => n.type === "Button" && n.props.children === "Save for review").onClick(); await h.flush();
  const write = h.calls.find((call) => call.name === "manualText")!;
  assert.equal(write.args[0].baseRevisionId, "m1-revision");
  assert.equal(write.args[0].text, "manual unsaved text");
  assert.equal(write.args[0].workspaceId, "A");
  h.cleanup();
});

test("P169-4 actual create/edit/delete consumers invalidate the single real-service session list", async () => {
  const h = fixture(); await h.flush();
  const chat = h.mountPanel("PreparationConversationPanel");
  const review = h.mountPanel("ReviewedPreparationPanel"); await h.flush();
  by(chat, (n) => n.type === "Button" && n.props.title === "New preparation conversation").onClick(); await h.flush();
  by(chat, (n) => n.type === "Input").onChange({ target: { value: "New fixture chat" } }); await h.flush();
  by(chat, (n) => n.type === "Button" && n.props.children?.includes?.("Create")).onClick(); await h.flush();
  assert.equal(h.data.selectedSessionId, "created-1");
  assert.equal(h.count("conversation.list"), 2);
  assert.ok(elements(review.output).some((n) => n.type === "SelectItem" && n.props.value === "created-1"));
  by(chat, (n) => n.type === "Button" && n.props.title === "Edit conversation").onClick(); await h.flush();
  by(chat, (n) => n.type === "Input").onChange({ target: { value: "Renamed fixture chat" } }); await h.flush();
  by(chat, (n) => n.type === "Button" && n.props.children?.includes?.("Save")).onClick(); await h.flush();
  assert.equal(h.data.sessions.data.find((s: any) => s.id === "created-1").title, "Renamed fixture chat");
  assert.equal(h.data.conversation.data.conversation.title, "Renamed fixture chat");
  assert.equal(h.count("conversation.list"), 3);
  by(chat, (n) => n.type === "Button" && n.props.title === "Back to preparation conversations").onClick(); await h.flush();
  const row = elements(chat.output).find((n) => n.type === "div" && n.props.className === "flex items-center border-b last:border-b-0"
    && elements(n).some((child) => child.props?.children === "Renamed fixture chat"));
  assert.ok(row);
  elements(row).find((n) => n.type === "Button" && n.props.title === "Delete conversation")!.props.onClick(); await h.flush();
  by(chat, (n) => n.type === "Button" && n.props.variant === "destructive" && n.props.children?.includes?.("Delete")).onClick(); await h.flush();
  assert.equal(h.data.selectedSessionId, undefined);
  assert.equal(h.count("conversation.list"), 4);
  assert.equal(h.data.sessions.data.some((s: any) => s.id === "created-1"), false);
  assert.equal(elements(review.output).some((n) => n.type === "SelectItem" && n.props.value === "created-1"), false);
  h.cleanup();
});

test("P169-1 stale same-key error is rejected and a normal retry can publish its own error then recover", async () => {
  const h = fixture(); await h.flush();
  const stale = deferred(), current = deferred();
  h.queue("material.list", stale.promise, current.promise);
  void h.data.refreshMaterials(); await h.flush();
  void h.data.refreshMaterials(); await h.flush();
  stale.reject(new Error("stale error")); await h.flush();
  assert.equal(h.data.materials.error, undefined);
  assert.equal(h.data.materials.loading, true);
  current.reject(new Error("current error")); await h.flush();
  assert.equal(h.data.materials.error, "current error");
  assert.equal(h.data.materials.loading, false);
  await h.data.refreshMaterials(); await h.flush();
  assert.equal(h.data.materials.error, undefined);
  assert.equal(h.data.materials.loading, false);
  h.cleanup();
});

test("P169-3 actual send consumer: old stream delta/error/finally cannot clear a replacement after session ABA", async () => {
  const h = fixture(); await h.flush();
  const chat = h.mountPanel("PreparationConversationPanel"); await h.flush();
  h.data.selectConversation("a1"); await h.flush();
  by(chat, (n) => n.type === "Textarea").onChange({ target: { value: "first" } }); await h.flush();
  const firstSend = by(chat, (n) => n.type === "Button" && n.props.title === "Send").onClick(); await h.flush();
  h.executions[0].input.onDelta("first partial"); await h.flush();
  h.data.selectConversation("a2"); await h.flush();
  h.data.selectConversation("a1"); await h.flush();
  assert.equal(h.executions[0].input.signal.aborted, false, "navigation alone keeps the conversation-owned request");
  by(chat, (n) => n.type === "Button" && n.props.title === "Cancel response").onClick(); await h.flush();
  assert.equal(h.executions[0].input.signal.aborted, true);
  by(chat, (n) => n.type === "Textarea").onChange({ target: { value: "second" } }); await h.flush();
  by(chat, (n) => n.type === "Button" && n.props.title === "Send").onClick(); await h.flush();
  h.executions[1].input.onDelta("second partial"); await h.flush();
  h.executions[0].input.onDelta("late first delta");
  h.executions[0].result.reject(new Error("late first error")); await h.flush();
  await firstSend;
  assert.equal(by(chat, (n) => n.type === "Textarea").disabled, true);
  assert.ok(elements(chat.output).some((n) => n.type === "Markdown" && n.props.children === "second partial"));
  assert.equal(h.data.error, undefined);
  h.executions[1].result.resolve({ status: "committed" }); await h.flush();
  assert.equal(by(chat, (n) => n.type === "Textarea").disabled, false);
  assert.equal(h.data.selectedSessionId, "a1");
  h.cleanup();
});

test("P169-4/5 late A writes only invalidate A and existing selection channel refreshes global selection without browsing activation", async () => {
  const h = fixture(); await h.flush();
  const fromA = h.data.refreshConversation;
  const aMaterials = h.data.refreshMaterials;
  h.selectProcess("B"); await h.flush();
  const before = h.calls.length;
  await fromA("a1"); await aMaterials(); await h.flush();
  assert.equal(h.calls.length, before);
  h.selectionEvent(); await h.flush();
  assert.deepEqual(h.calls.slice(before).map((call) => call.name).sort(), ["context", "selected", "snapshots"]);
  assert.equal(h.data.detail.data.process.id, "B");
  h.selectProcess("A"); await h.flush();
  const listBefore = h.count("conversation.list");
  await fromA("a1"); await h.flush();
  assert.equal(h.count("conversation.list"), listBefore + 1, "a legitimate late write invalidates a revisited A");
  h.cleanup();
});

test("P169-1/4 Reviewed compose callbacks reject old scope notice/finally and accept the new operation", async () => {
  const h = fixture(); h.setStatementStatus("confirmed"); await h.flush();
  const review = h.mountPanel("ReviewedPreparationPanel"); await h.flush();
  const old = deferred(), fresh = deferred(); h.queue("compose", old.promise, fresh.promise);
  by(review, (n) => n.type === "Button" && n.props.children?.includes?.("Compose confirmed profile")).onClick(); await h.flush();
  h.data.selectReviewScope("round:A-r2"); await h.flush();
  h.data.selectReviewScope("round:A-r1"); await h.flush();
  by(review, (n) => n.type === "Button" && n.props.children?.includes?.("Compose confirmed profile")).onClick(); await h.flush();
  old.resolve({ created: true, profile: { revision: 99 } }); await h.flush();
  assert.equal(h.data.notice, undefined);
  assert.equal(by(review, (n) => n.type === "Button" && n.props.children?.includes?.("Compose confirmed profile")).disabled, true);
  fresh.resolve({ created: true, profile: { revision: 2 } }); await h.flush();
  assert.equal(h.data.notice, "Profile revision 2 composed");
  assert.equal(by(review, (n) => n.type === "Button" && n.props.children?.includes?.("Compose confirmed profile")).disabled, false);
  h.cleanup();
});

test("P169-4/5 Reviewed review/compile/activation consumers retain source revision and explicit selection authority", async () => {
  const h = fixture(); await h.flush();
  const review = h.mountPanel("ReviewedPreparationPanel"); await h.flush();
  by(review, (n) => n.type?.name === "StatementRow").onReview(); await h.flush();
  await by(review, (n) => n.type?.name === "StatementReviewDialog").onSave({ status: "confirmed", content: "Reviewed fixture", domain: "unknown", ownership: "unresolved" }); await h.flush();
  const saved = h.calls.find((call) => call.name === "statement.review")!.args[0];
  assert.equal(saved.processId, "A");
  assert.equal(saved.statementId, "A:A-r1");
  assert.equal(saved.expectedRevision, 3);
  h.queue("profile", Promise.resolve({ id: "profile-1", revision: 1, sourceFingerprint: "fingerprint" }));
  await h.data.refreshReviewed(); await h.flush();
  const button = by(review, (n) => n.type === "Button" && n.props.children?.includes?.("Compile snapshot"));
  assert.equal(button.disabled, false);
  button.onClick(); await h.flush();
  assert.equal(h.count("activate"), 0, "compilation/browsing never activates");
  const snapshotDialog = by(review, (n) => n.type?.name === "SnapshotReviewDialog");
  assert.equal(snapshotDialog.snapshot.id, "snapshot-1");
  const before = h.count("context");
  await snapshotDialog.onActivate(false); await h.flush();
  const activation = h.calls.find((call) => call.name === "activate")!.args[0];
  assert.equal(activation.processId, "A");
  assert.equal(activation.roundId, "A-r1");
  assert.equal(activation.snapshotId, "snapshot-1");
  assert.equal(activation.allowContextSwitch, false);
  assert.equal(h.count("context"), before + 1);
  h.cleanup();
});

for (const kind of ["process", "round"] as const) {
  test(`P169-4 late ${kind} statement review follows the existing inherited-scope query, not the old display scope`, async () => {
    const h = fixture();
    h.queue("statements", Promise.resolve([{ id: "statement-1", processId: "A", revision: 4,
      status: "proposed", scope: kind === "process" ? { kind } : { kind, roundId: "A-r1" } }]));
    await h.flush();
    const panel = h.mountPanel("ReviewedPreparationPanel"); await h.flush();
    by(panel, (n) => n.type?.name === "StatementRow").onReview(); await h.flush();
    const mutation = deferred(); h.queue("statement.review", mutation.promise);
    const saving = by(panel, (n) => n.type?.name === "StatementReviewDialog").onSave({ status: "confirmed" });
    await h.flush();
    h.data.selectReviewScope("round:A-r2"); await h.flush();
    const reads = h.count("statements");
    h.setStatementStatus("confirmed"); mutation.resolve(undefined); await h.flush(); await saving;
    assert.equal(h.count("statements"), reads + (kind === "process" ? 1 : 0));
    assert.equal(h.data.notice, undefined, "the original scope's completion cannot publish a notice in the new scope");
    h.cleanup();
  });
}
