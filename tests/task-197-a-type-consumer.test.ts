import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { build } from "esbuild";
import ts from "typescript";

const root = process.cwd();
const hookPath = "src/hooks/useMeetingAssistant.ts";
const hook = readFileSync(hookPath, "utf8");
const ast = ts.createSourceFile(hookPath, hook, ts.ScriptTarget.Latest, true);
const all = (node: ts.Node, predicate: (node: ts.Node) => boolean) => {
  const found: ts.Node[] = [];
  const visit = (current: ts.Node) => {
    if (predicate(current)) found.push(current);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
};
const scheduler = all(
  ast,
  (node) =>
    ts.isVariableDeclaration(node) &&
    node.name.getText(ast) === "scheduleQuestionTypeAdjudication"
)[0] as ts.VariableDeclaration;
assert.ok(scheduler);
const body = (scheduler.initializer as ts.CallExpression)
  .arguments[0] as ts.ArrowFunction;
const statements = [...(body.body as ts.Block).statements];
const statementWith = (name: string) =>
  statements.findIndex(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) => declaration.name.getText(ast) === name
      )
  );
const leaseBlock = statements
  .slice(statementWith("activeParent"), statementWith("prompts"))
  .map((node) => node.getText(ast))
  .join("\n");
assert.match(leaseBlock, /authorizationLogicalQuestionUnit \?\? logicalQuestionUnitRef.current/);
const settled = all(
  body,
  (node) =>
    ts.isPropertyAssignment(node) && node.name.getText(ast) === "onSettled"
)[0] as ts.PropertyAssignment;
assert.ok(settled);
const consumerStatements = [
  ...((settled.initializer as ts.ArrowFunction).body as ts.Block).statements,
];
const rawIndex = consumerStatements.findIndex(
  (node) =>
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(
      (declaration) => declaration.name.getText(ast) === "rawOutput"
    )
);
assert.ok(rawIndex > 0);
const consumerBlock = consumerStatements
  .slice(0, rawIndex)
  .map((node) => node.getText(ast))
  .join("\n");
assert.equal(
  all(
    ast,
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === "scheduleQuestionTypeAdjudication"
  ).length,
  3
);

const moduleNames = [
  "taxonomy-adjudication", "question-type-adjudication", "current-question-settlement",
  "context-manager", "logical-question-unit", "active-question-term-correction",
  "term-correction-reversal", "source-owned-transition-transaction",
  "manual-question-type-correction", "project-binding-transaction", "active-branch-phase",
  "interview-playbook", "task-taxonomy", "screen-task-scope",
  "manual-screen-question-source", "logical-question-ownership",
];
const bundled = await build({
  stdin: {
    contents: moduleNames.map((name, index) =>
      `export * as m${index} from './src/lib/meeting/${name}.ts';`
    ).join("\n"),
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "error",
});
const namespaces = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);
const api: any = Object.assign({}, ...Object.values(namespaces));
const evaluate = (source: string, env: Record<string, unknown>) => {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return Function(...Object.keys(env), compiled)(...Object.values(env));
};
const freeze = (value: any): any => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  }
  return value;
};
const turn = (id: string) => ({
  id,
  text: "Implement an LRU cache with constant-time get and put.",
  speaker: "them",
  startedAt: 1_000,
  endedAt: 1_100,
  isFinal: true,
  source: "system-audio",
});
const voiceUnit = (ctx: any, id = "turn-a") =>
  api.composeCanonicalTurnCandidate({
    currentTurn: turn(id),
    sessionId: ctx.manager.getState().sessionId,
    runtimeEpoch: ctx.epoch.current,
    now: 1_100,
  });
const playbook = (type: string) =>
  api.selectInterviewPlaybookForCommittedType({
    questionType: type,
    query: type === "coding" ? "Implement LRU cache" : "Design a retrieval service",
    classifierConfidence: 1,
  }).playbook;

function sourceTransition(
  ctx: any,
  relation: string,
  type: string,
  question = "Design a retrieval service",
  preserveChildId?: string
) {
  const current = ctx.manager.getTaskRuntimeState();
  const candidate = api.createSourceOwnedTransitionCandidate({
    sessionId: ctx.manager.getState().sessionId,
    runtimeEpoch: ctx.epoch.current,
    source: "voice",
    sourceTurnIds: [`transition-turn-${++ctx.seq}`],
    existingTask: current.parent,
    relation,
    authoritySource: "runtime-adjudication",
    mutationAuthorized: true,
    questionType: type,
    question,
    playbook: playbook(type),
    preserveChildId,
    now: 2_000 + ctx.seq,
  });
  assert.ok(candidate);
  const prepared = api.prepareSourceOwnedTransition({
    candidate,
    currentTask: current.parent,
    currentSessionId: ctx.manager.getState().sessionId,
    currentRuntimeEpoch: ctx.epoch.current,
    now: 2_100 + ctx.seq,
  });
  assert.ok(prepared.mutationApplied, prepared.reason);
  const transition = candidate.kind === "new-parent"
    ? (current.parent ? "replace-parent" : "create-parent")
    : candidate.kind === "reseed-parent" ? "replace-parent"
      : candidate.kind === "resume-parent" ? "resume-parent"
        : candidate.kind === "child-probe" ? "attach-child" : "set-phase";
  const transaction = ctx.manager.prepareTaskRuntimeTransition({
    id: `transition-${ctx.seq}`,
    transition,
    reason: "test-source-owned-command",
    parent: prepared.task,
    expectedRevision: current.revision,
  });
  const committed = ctx.manager.commitPreparedTaskRuntimeTransition(transaction);
  assert.ok(committed.authorized && committed.mutationApplied, committed.reason);
  return transaction;
}

function correction(ctx: any) {
  const value = {
    id: `correction-${++ctx.seq}`,
    input: "Use a bounded cache",
    term: "bounded cache",
    from: "LRU cache",
    to: "bounded cache",
    createdAt: 3_000,
  };
  const applied = api.applyActiveQuestionTermCorrection({
    logicalQuestionUnit: ctx.current.current,
    correction: value,
    manualCorrectionRevision: ++ctx.manual.current,
    correctionTraceId: "correction-trace",
    now: 3_000,
  });
  ctx.current.current = applied.logicalQuestionUnit;
  return value;
}

function retype(ctx: any, type = "general-system-design") {
  const current = ctx.manager.getTaskRuntimeState();
  const parent = api.applyManualQuestionTypeCorrectionToParent({
    parent: current.parent,
    decision: { noOp: false, target: "parent", correctedType: type },
    correctedPlaybook: playbook(type),
    now: 3_000,
  });
  assert.equal(parent.revisions, current.parent.revisions + 1);
  const result = ctx.manager.commitTaskRuntimeTransition({
    id: "retype",
    transition: "replace-parent",
    reason: "test-manual-retype",
    parent,
    expectedRevision: current.revision,
  });
  assert.ok(result.authorized, result.reason);
}

function attachScreen(ctx: any, kind = "coding") {
  const state = ctx.manager.getTaskRuntimeState();
  const screen = state.screenAttachment
    ? { ...state.screenAttachment, updatedAt: state.screenAttachment.updatedAt + 1, content: "new source attachment" }
    : { id: "screen-a", observationId: "observation-a", createdAt: 1_000,
        updatedAt: 2_000, question: "Implement LRU cache", kind, content: "",
        basedOnTurnIds: [], basedOnObservationId: "observation-a" };
  const result = ctx.manager.commitTaskRuntimeTransition({
    id: "screen-attachment",
    transition: "update-source-attachment",
    reason: "test-screen-attachment",
    screenAttachment: screen,
    expectedRevision: state.revision,
  });
  assert.ok(result.authorized, result.reason);
}

function makeContext(entry: string, seed = "parent") {
  const ctx: any = {
    manager: new api.MeetingContextManager(),
    epoch: { current: 1 },
    manual: { current: 0 },
    current: { current: undefined },
    operation: { current: "operation-a" },
    seq: 0,
  };
  if (seed !== "none" && seed !== "screen-only") {
    sourceTransition(ctx, "new-parent", seed === "project-child" ? "project-deep-dive" : "ai-ml-system-design");
  }
  if (seed === "child" || seed === "project-child") {
    ctx.seedTransaction = sourceTransition(ctx, "child-probe", "field-knowledge", "Explain HNSW");
  }
  if (seed === "screen-only") attachScreen(ctx);
  ctx.current.current = voiceUnit(ctx);
  if (entry.startsWith("screen-")) {
    const voiceQuestion = entry === "screen-bound-review"
      ? { logicalQuestionUnitId: ctx.current.current.id,
          logicalQuestionRevision: ctx.current.current.revision,
          sourceTurnIds: [...ctx.current.current.sourceTurnIds],
          text: ctx.current.current.normalizedText }
      : undefined;
    const packet = api.resolveManualScreenSourcePacket({
      voiceQuestion,
      screenObservationId: "screen-input",
      screenPreflightQuestion: "Implement an LRU cache with constant-time get and put.",
    });
    ctx.current.current = api.buildManualScreenLogicalQuestionUnit({
      packet,
      sessionId: ctx.manager.getState().sessionId,
      runtimeEpoch: 1,
      createdAt: 1_000,
      transcriptTurns: [],
    });
  }
  if (entry.startsWith("term-correction")) correction(ctx);
  return ctx;
}

const scenarios: Array<{ name: string; seed?: string; change: (ctx: any) => void }> = [
  { name: "unchanged", change: () => {} },
  { name: "new-lqu-current-ref", change: (c) => { c.current.current = voiceUnit(c, "turn-b"); } },
  { name: "superseding-type-operation", change: (c) => { c.current.current = voiceUnit(c, "turn-b"); c.operation.current = "operation-b"; } },
  { name: "term-correction", change: correction },
  { name: "term-correction-stop", change: (c) => { const value = correction(c); const result = api.reverseActiveQuestionTermCorrection({ logicalQuestionUnit: c.current.current, correction: value, corrections: [value], now: 4_000 }); assert.ok(result.reversed); c.current.current = result.logicalQuestionUnit; c.manual.current++; } },
  { name: "human-retype", change: (c) => { c.manual.current++; retype(c); } },
  { name: "same-owner-retype-no-manual-change", change: (c) => retype(c) },
  { name: "first-parent-created", seed: "none", change: (c) => sourceTransition(c, "new-parent", "coding") },
  { name: "replace-parent", change: (c) => sourceTransition(c, "new-parent", "behavioral", "Describe a conflict") },
  { name: "attach-child", change: (c) => sourceTransition(c, "child-probe", "field-knowledge", "Explain HNSW") },
  { name: "sibling-child-detour", seed: "child", change: (c) => sourceTransition(c, "child-probe", "field-knowledge", "Explain BM25") },
  { name: "child-preserve", seed: "child", change: (c) => sourceTransition(c, "child-probe", "field-knowledge", "And its tradeoffs?", c.manager.getTaskRuntimeState().parent.child.id) },
  { name: "resume-parent", seed: "child", change: (c) => sourceTransition(c, "resume-parent", "ai-ml-system-design", "Back to the retrieval architecture") },
  { name: "project-rebind-clears-child", seed: "project-child", change: (c) => { const s = c.manager.getTaskRuntimeState(); const r = api.commitProjectBindingSettlement({ currentTask: s.parent, decision: { action: "rebind", binding: { projectId: "project-b", projectName: "Project B", revision: 1, evidenceEntryIds: [], sourceTurnIds: [], source: "user-selection", confidence: 1 }, bindingRevision: 1, candidates: [], sourceTurnIds: [] }, expectedParentId: s.parent.id, expectedParentRevision: s.parent.revisions, now: 3_000 }); assert.ok(r.committed); const result = c.manager.commitTaskRuntimeTransition({ id: "binding", transition: "update-parent-context", reason: "test-binding", parent: r.task, expectedRevision: s.revision }); assert.ok(result.authorized, result.reason); } },
  { name: "parent-phase", change: (c) => { const s = c.manager.getTaskRuntimeState(); const resolved = api.resolveEffectiveBranchPhase(s.parent); assert.equal(resolved.status, "resolved"); const parent = api.applyActiveBranchPhase({ parent: s.parent, owner: resolved.view, targetPhase: "architecture_design", phaseProgress: resolved.view.phaseProgress, playbook: resolved.view.playbook, now: 3_000 }); assert.ok(parent); const result = c.manager.commitTaskRuntimeTransition({ id: "phase", transition: "set-phase", reason: "test-phase", parent, expectedRevision: s.revision }); assert.ok(result.authorized, result.reason); } },
  { name: "ordinary-context-update", change: (c) => { const s = c.manager.getTaskRuntimeState(); const result = c.manager.commitTaskRuntimeTransition({ id: "context", transition: "update-parent-context", reason: "test-context", parent: { ...s.parent, updatedAt: 3_000, supportedFactAnchors: ["known-anchor"], revisions: s.parent.revisions + 1 }, expectedRevision: s.revision }); assert.ok(result.authorized, result.reason); } },
  { name: "attach-screen-preserves-parent", change: (c) => attachScreen(c) },
  { name: "clear-parent", change: (c) => c.manager.clearTaskRuntime({ id: "clear", scope: "parent", reason: "test-clear" }) },
  { name: "clear-all", change: (c) => c.manager.clearTaskRuntime({ id: "clear", scope: "all", reason: "test-clear" }) },
  { name: "expire-parent", change: (c) => { const s = c.manager.getTaskRuntimeState(); const prepared = c.manager.prepareTaskDeadlineUpdate({ expectedSessionId: c.manager.getState().sessionId, deadlineDelta: { parent: { ownerId: s.parent.id, deadline: 1 } } }); assert.ok(c.manager.installPreparedTaskDeadlineUpdate(prepared)); assert.ok(c.manager.clearExpiredActiveMeetingTask(2)); } },
  { name: "pause-work-epoch", change: (c) => { c.epoch.current++; } },
  { name: "session-reset", change: (c) => c.manager.reset() },
  { name: "rollback-attachment", change: (c) => { const transaction = sourceTransition(c, "child-probe", "field-knowledge", "Explain HNSW"); assert.ok(c.manager.rollbackPreparedTaskRuntimeTransition(transaction)); } },
  { name: "rollback-captured-child-state", seed: "child", change: (c) => assert.ok(c.manager.rollbackPreparedTaskRuntimeTransition(c.seedTransaction)) },
  { name: "stale-write-rejected", change: (c) => { const s = c.manager.getTaskRuntimeState(); const result = c.manager.commitTaskRuntimeTransition({ id: "stale", transition: "replace-parent", reason: "test-stale", expectedRevision: s.revision - 1, parent: { ...s.parent, id: "must-not-appear" } }); assert.equal(result.authorized, false); } },
  { name: "snapshot-mutation-isolated", change: (c) => { const s = c.manager.getState(); s.taskRuntime.parent.stableKind = "coding"; s.activeMeetingTask.parent.questionType = "coding"; assert.equal(c.manager.getState().activeMeetingTask.parent.questionType, "ai-ml-system-design"); } },
  { name: "screen-only-projection-no-change", seed: "screen-only", change: () => {} },
  { name: "screen-only-clear", seed: "screen-only", change: (c) => c.manager.clearTaskRuntime({ id: "clear", scope: "screen", reason: "test-clear" }) },
];

type Expected = [string, string, string, string | null, boolean, Record<string, unknown>];
const expectedRows = readFileSync("tests/fixtures/task-197-a-type-consumer.jsonl", "utf8")
  .trim().split("\n").map((line) => JSON.parse(line) as Expected);
const expectations = new Map(expectedRows.map((row) => [JSON.stringify(row.slice(0, 3)), row]));
type DiagnosticChange = [string, string, string, string, string];
const diagnosticRows = readFileSync("tests/fixtures/task-197-a-diagnostic-changes.jsonl", "utf8")
  .trim().split("\n").map((line) => JSON.parse(line) as DiagnosticChange);
const diagnosticChanges = new Map(
  diagnosticRows.map((row) => [JSON.stringify(row.slice(0, 3)), row])
);

test("197A Type consumer matches 224 frozen producer/order scenarios", async () => {
  assert.equal(scenarios.length, 28);
  assert.equal(expectations.size, 224);
  assert.equal(diagnosticChanges.size, 48);
  for (const entry of ["voice", "screen-review", "screen-bound-review", "term-correction"]) {
    for (const scenario of scenarios) {
      for (const order of ["before-change", "after-change"]) {
        const label = `${entry}/${scenario.name}/${order}`;
        const ctx = makeContext(entry, scenario.seed);
        const scheduled = freeze(ctx.current.current);
        const sourceBefore = JSON.stringify(scheduled);
        const screen = entry.startsWith("screen-");
        const request = api.buildQuestionTypeAdjudicationRequest({
          logicalQuestionUnit: scheduled,
          reviewScope: screen ? "field-vs-coding" : "full",
        });
        const evidence = request.question.sourceTurns[0].text;
        const parsed = api.parseQuestionTypeAdjudicationOutput(
          JSON.stringify(screen
            ? { v: 1, cs: 0.98, fs: 0.01, us: 0.01, e: evidence }
            : { v: 1, t: "coding", c: 0.98, e: evidence }),
          request
        );
        assert.ok(parsed.ok, label);
        const contextState = ctx.manager.getState();
        const env = {
          ...api,
          contextState,
          contextManagerRef: { current: ctx.manager },
          runtimeEpochRef: ctx.epoch,
          manualCorrectionRevisionRef: ctx.manual,
          logicalQuestionUnit: scheduled,
          authorizationLogicalQuestionUnit: scheduled,
          logicalQuestionUnitRef: ctx.current,
          operationIdOverride: "operation-a",
          questionTypeAdjudicationRuntimeRef: {
            current: { getCurrentOperationId: () => ctx.operation.current },
          },
        };
        const captured = evaluate(`${leaseBlock}\nreturn {lease,authorizeTypeOperation};`, env);
        assert.equal("sourceTurnIdsHash" in captured.lease, false, label);
        assert.equal("taskBoundaryEpoch" in captured.lease, false, label);
        const consume = () => evaluate(
          `${consumerBlock}\nreturn {authorization,enforcement,settlementPreview};`,
          {
            ...env,
            ...captured,
            settlement: {
              job: { lease: captured.lease },
              result: { parsed, providerDisposition: "completed-with-content" },
              disposition: "completed",
            },
            request,
            sourceKind: screen ? (entry === "screen-bound-review" ? "mixed" : "screen") : "voice",
            sourceObservationIds: screen ? ["screen-input"] : [],
            MeetingAIResponseOutcomeError: class extends Error {},
            questionTypeAdjudicationCandidateCacheRef: { current: { write() {} } },
            cacheKey: "fixture",
            questionTypeAdjudicationCircuitRef: { current: { open() { throw Error("unexpected provider error"); } } },
            effectiveQuestionTypeMode: "enforcement",
            localQuestionType: screen ? "field-knowledge" : "unknown",
            sourceOwnedSubstantive: true,
            manualCorrectionOperationCoordinatorRef: { current: { getActiveOperationId: () => undefined } },
          }
        );
        const completed = Promise.resolve().then(consume);
        if (order === "after-change") scenario.change(ctx);
        const consumed = await completed;
        if (order === "before-change") scenario.change(ctx);
        assert.equal(JSON.stringify(scheduled), sourceBefore, label);
        const task = ctx.manager.getState().activeMeetingTask;
        const effective = api.decideOrderedVoiceQuestionTypeResolution({
          llmSettlement: consumed.settlementPreview,
          llmAuthorized: consumed.enforcement.authorized,
          currentBranchType: task?.child?.questionType ?? task?.parent.questionType,
        });
        const key = JSON.stringify([entry, scenario.name, order]);
        const expected = expectations.get(key);
        assert.ok(expected, label);
        assert.equal(consumed.authorization.authorized, expected[3] === null, label);
        assert.equal(consumed.authorization.reason ?? null, expected[3], label);
        assert.equal(consumed.enforcement.authorized, expected[4], label);
        assert.deepEqual(JSON.parse(JSON.stringify(effective)), expected[5], label);
        const diagnosticChange = diagnosticChanges.get(key);
        if (diagnosticChange) {
          assert.equal(diagnosticChange[3], "task-boundary-epoch-mismatch", label);
          assert.equal(consumed.authorization.reason, diagnosticChange[4], label);
          assert.equal(consumed.authorization.authorized, false, label);
          diagnosticChanges.delete(key);
        }
        expectations.delete(key);
      }
    }
  }
  assert.equal(expectations.size, 0);
  assert.equal(diagnosticChanges.size, 0);
});
