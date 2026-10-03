import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveOrderedTaskRelationWithinWindow, type OrderedRelationOperationDependencies,
  type TaskRelationAdjudicationScheduleHandle } from "../src/lib/meeting/ordered-relation-operation.js";
import { CORRECTION_ORDERED_RELATION_FOREGROUND_BUDGET_MS, ORDERED_RELATION_STAGE_BUDGET_MS,
  SCREEN_ORDERED_RELATION_FOREGROUND_BUDGET_MS, VOICE_ORDERED_RELATION_FOREGROUND_BUDGET_MS,
  type TaskRelationSplitAffinityOutcome } from "../src/lib/meeting/task-relation-split-shadow.js";

// The operation takes a clock and a metadata sink only: it has no timer of its own.
const dependencies: OrderedRelationOperationDependencies = {
  now: () => 1_000,
  recordMetadata: (_traceId: string, _metadata: Record<string, unknown>) => {},
};
const handle = (): TaskRelationAdjudicationScheduleHandle => ({ releaseWindowRequested: true,
  authorizeOperation: () => ({ authorized: true, reason: "authorized" }) });

test("OR direct operation uses the shared first-parent matrix without Canonical", async () => {
  const h = handle();
  h.startCanonical = () => { throw new Error("unexpected Canonical invocation"); };
  const result = await resolveOrderedTaskRelationWithinWindow({ handle: h, traceId: "first-parent",
    sourceKind: "voice", currentQuestionType: "coding", waitBudgetMs: 8_000 }, dependencies);
  assert.equal(result.terminalDisposition, "resolved");
  assert.equal(result.decision.relation, "new-parent");
  assert.equal(result.metadata.taskRelationOrderedResolutionWaitMs, 0);
});

test("OR invalid operation cannot release even a deterministic decision", async () => {
  let cancelled = 0;
  const h = { ...handle(), authorizeOperation: () => ({ authorized: false, reason: "epoch-changed" }),
    cancelForegroundWork: () => { cancelled++; } };
  const result = await resolveOrderedTaskRelationWithinWindow({ handle: h, traceId: "stale",
    sourceKind: "screen", currentQuestionType: "coding", waitBudgetMs: 8_000 }, dependencies);
  assert.equal(result.terminalDisposition, "cancelled");
  assert.equal(result.operationAuthorization.reason, "epoch-changed");
  assert.equal(cancelled, 1);
});

test("OR unexpected affinity failure propagates without semantic fallback", async () => {
  const error = new Error("broken internal invariant");
  const h = { ...handle(), affinityOutcome: Promise.reject(error) };
  await assert.rejects(resolveOrderedTaskRelationWithinWindow({ handle: h, traceId: "failure",
    sourceKind: "voice", currentQuestionType: "coding", waitBudgetMs: 8_000 }, dependencies),
  caught => caught === error);
});

// ---- ST183: the consumer uses each stage terminal; it does not time a stage ----

const independent = () => ({ operationId: "parent-affinity", outputHash: "hash", settledAt: 500,
  adjudication: { schemaVersion: 1 as const, affinityKind: "parent" as const, decision: "independent" as const,
    confidence: 0.95, currentEvidenceSpans: ["ask"], branchEvidenceSpans: [] } });
const activeMeetingTask = { parent: { questionType: "coding" } } as Parameters<typeof resolveOrderedTaskRelationWithinWindow>[0]["activeMeetingTask"];

test("ST183-2 OR a consumer that starts at the cutoff still consumes the stage terminal, not the pending snapshot", async () => {
  let release!: (outcome: { child: object; parent: object }) => void;
  const canonicalInputs: unknown[] = [];
  const h: TaskRelationAdjudicationScheduleHandle = { ...handle(),
    // now() is already at the stage deadline: no time is left to wait.
    affinityDeadlineAt: 1_000,
    affinityOutcome: new Promise(resolve => { release = resolve; }),
    readAffinityOutcome: () => { throw new Error("the published snapshot must not stand in for the stage terminal"); },
    startCanonical: async input => { canonicalInputs.push(input.affinityOutcome); return { unavailableReason: "invalid-output" }; } };
  const resolution = resolveOrderedTaskRelationWithinWindow({ handle: h, traceId: "terminal", sourceKind: "screen",
    currentQuestionType: "coding", activeMeetingTask, waitBudgetMs: 8_000 }, dependencies);
  await Promise.resolve();
  assert.equal(canonicalInputs.length, 0, "Canonical waits for the Affinity stage to end");
  release({ child: { unavailableReason: "no-active-child" }, parent: independent() });
  const result = await resolution;
  assert.equal(canonicalInputs.length, 1);
  assert.deepEqual(canonicalInputs[0], { child: { unavailableReason: "no-active-child" }, parent: independent() });
  assert.equal(result.metadata.taskRelationOrderedResolutionAffinityParentDisposition, "available");
  assert.equal(result.decision.matrix.parentAffinityDecision, "independent");
});

test("ST183-2 OR a terminal result completed after the cutoff is filtered by its own completion time", async () => {
  const h: TaskRelationAdjudicationScheduleHandle = { ...handle(), affinityDeadlineAt: 1_000,
    affinityOutcome: Promise.resolve({ child: { unavailableReason: "no-active-child" },
      parent: { ...independent(), settledAt: 1_001 } }) };
  const result = await resolveOrderedTaskRelationWithinWindow({ handle: h, traceId: "late", sourceKind: "screen",
    currentQuestionType: "coding", activeMeetingTask, waitBudgetMs: 8_000 }, dependencies);
  assert.equal(result.affinityOutcome?.parent.adjudication, undefined);
  assert.equal(result.metadata.taskRelationOrderedResolutionAffinityParentDisposition, "affinity-settled-after-cutoff");
});

// ---- ST183: the consumer keeps the foreground window its caller gave ----

const related = () => ({ ...independent(), adjudication: { ...independent().adjudication,
  decision: "related" as const, branchEvidenceSpans: ["parent"] } });
const foregroundRecord = (metadata: Record<string, unknown>) => ({
  waitBudgetMs: metadata.taskRelationOrderedResolutionWaitBudgetMs,
  deadlineAt: metadata.taskRelationOrderedResolutionDeadlineAt,
  affinityCutoffAt: metadata.taskRelationOrderedResolutionAffinityCutoffAt,
  canonicalDeadlineAt: metadata.taskRelationOrderedResolutionCanonicalDeadlineAt,
  foregroundDeadlineAt: metadata.orderedSettlementForegroundDeadlineAt,
  foregroundBudgetMs: metadata.orderedSettlementForegroundBudgetMs,
  remainingMs: metadata.taskRelationOrderedResolutionRemainingMs,
  lateWorkCancelled: metadata.taskRelationOrderedResolutionLateWorkCancelled,
  waitDisposition: metadata.taskRelationOrderedResolutionWaitDisposition,
});

// A caller whose own budget is shorter than the stage. The stage started at 1000
// and ends at 5000; the caller's budget ended at 1001.
const shortBudgetCaller = { traceId: "short-budget", sourceKind: "voice" as const, currentQuestionType: "coding" as const,
  activeMeetingTask, waitBudgetMs: 1 };

test("ST183-2 ST183-6 OR a caller budget shorter than the stage only narrows the completion-time cutoff; the consumer does not extend it to the stage deadline", async () => {
  // The consumer holds no timer and awaits the stage terminal whatever the
  // caller's budget is. It keeps the caller's deadline as given, so a result that
  // completed after the caller's cutoff is not used although the stage selected
  // it in time. A caller with a stage terminal must therefore grant the stage
  // window, which the three production call sites do (source pin below).
  const outcome = (settledAt: number) => ({ child: { unavailableReason: "no-active-child" },
    parent: { ...related(), settledAt } });
  // The rule is the same with and without a stage terminal: no terminal-specific branch.
  for (const [shape, source, waitDisposition] of [
    ["stage terminal", (settledAt: number) => ({ affinityOutcome: Promise.resolve(outcome(settledAt)) }), "affinity-settled"],
    ["synchronous snapshot", (settledAt: number) => ({ readAffinityOutcome: () => outcome(settledAt) }), "affinity-unavailable"],
  ] as const) {
    // Completed at 3000: inside the stage, after the caller's cutoff.
    const canonicalInputs: Array<TaskRelationSplitAffinityOutcome | undefined> = [];
    const late = await resolveOrderedTaskRelationWithinWindow({ ...shortBudgetCaller,
      handle: { ...handle(), affinityDeadlineAt: 5_000, ...source(3_000),
        startCanonical: async input => { canonicalInputs.push(input.affinityOutcome); return { unavailableReason: "invalid-output" }; } } },
    { ...dependencies, now: () => 5_000 });
    assert.equal(late.metadata.taskRelationOrderedResolutionAffinityCutoffAt, 1_001, `${shape}: cutoff`);
    assert.equal(late.metadata.taskRelationOrderedResolutionAffinityParentDisposition, "affinity-settled-after-cutoff", shape);
    assert.equal(late.decision.matrix.parentAffinityDecision, undefined, `${shape}: the result is not adopted`);
    assert.deepEqual(canonicalInputs.map(input => [input?.parent.adjudication, input?.parent.unavailableReason]),
      [[undefined, "affinity-settled-after-cutoff"]], `${shape}: Canonical does not read it either`);

    // Completed at 900, before the caller's cutoff: it is used, and the recorded
    // window is the caller's own. Read at 5000, that window closed long ago.
    let cancelled = 0;
    const early = await resolveOrderedTaskRelationWithinWindow({ ...shortBudgetCaller,
      handle: { ...handle(), affinityDeadlineAt: 5_000, ...source(900),
        startCanonical: () => { throw new Error("unexpected Canonical invocation"); },
        cancelForegroundWork: () => { cancelled++; } } },
    { ...dependencies, now: () => 5_000 });
    assert.deepEqual([early.terminalDisposition, early.decision.stage, early.decision.relation],
      ["resolved", "runtime-matrix", "followup-parent"], shape);
    assert.deepEqual(foregroundRecord(early.metadata), { waitBudgetMs: 1, deadlineAt: 1_001, affinityCutoffAt: 1_001,
      canonicalDeadlineAt: undefined, foregroundDeadlineAt: 1_001, foregroundBudgetMs: 1, remainingMs: 0,
      lateWorkCancelled: true, waitDisposition }, `${shape}: the caller's deadline is recorded as given`);
    assert.equal(cancelled, 1, `${shape}: the caller's own window has closed`);
  }
});

test("ST183-6 OR source pin: the Voice, Screen and Correction call sites each pass their two-stage foreground budget constant", () => {
  const hook = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
  // Every call of the Hook's Ordered-operation binding, in file order: Voice, Screen, Correction.
  const calls = [...hook.matchAll(/\bresolveOrderedTaskRelationWithinWindow\(\{([\s\S]*?)\}\);/g)].map(match => match[1]);
  assert.equal(hook.split("resolveOrderedTaskRelationWithinWindow({").length - 1, 3, "production call sites");
  assert.deepEqual(calls.map(call => /\bwaitBudgetMs:\s*([^,\n]+),/.exec(call)?.[1]), [
    "VOICE_ORDERED_RELATION_FOREGROUND_BUDGET_MS",
    "SCREEN_ORDERED_RELATION_FOREGROUND_BUDGET_MS",
    "CORRECTION_ORDERED_RELATION_FOREGROUND_BUDGET_MS",
  ]);
  assert.deepEqual(calls.map(call => /\bsourceKind:\s*([^,\n]+),/.exec(call)?.[1]),
    ['taskRelationHandle.sourceKind ?? "voice"', '"screen"', "correctionSourceKind"], "the call sites are these three entries");
  // Each constant covers the Affinity stage and a necessary Canonical stage.
  assert.deepEqual([VOICE_ORDERED_RELATION_FOREGROUND_BUDGET_MS, SCREEN_ORDERED_RELATION_FOREGROUND_BUDGET_MS,
    CORRECTION_ORDERED_RELATION_FOREGROUND_BUDGET_MS], Array(3).fill(2 * ORDERED_RELATION_STAGE_BUDGET_MS));
});

test("ST183-6 OR Canonical gets 4 s from its enqueue whenever the stage terminal settled, whatever budget the caller passed", async () => {
  // The two-stage window of the production call sites, and a budget shorter than the stage.
  for (const [waitBudgetMs, affinityCutoffAt] of [[8_000, 5_000], [1, 1_001]] as const) for (const consumedAt of [3_000, 5_000, 5_200]) {
    const deadlines: Array<number | undefined> = [];
    const h: TaskRelationAdjudicationScheduleHandle = { ...handle(), affinityDeadlineAt: 5_000,
      affinityOutcome: Promise.resolve({ child: { unavailableReason: "no-active-child" },
        parent: { ...independent(), settledAt: 2_900 } }),
      startCanonical: async input => { deadlines.push(input.deadlineAt); return { unavailableReason: "invalid-output" }; } };
    const result = await resolveOrderedTaskRelationWithinWindow({ handle: h, ...shortBudgetCaller, waitBudgetMs },
      { ...dependencies, now: () => consumedAt });
    assert.deepEqual(deadlines, [consumedAt + 4_000], `Canonical deadline for a terminal consumed at ${consumedAt}, budget ${waitBudgetMs}`);
    assert.deepEqual(foregroundRecord(result.metadata), { waitBudgetMs: consumedAt + 3_000, deadlineAt: consumedAt + 4_000,
      affinityCutoffAt, canonicalDeadlineAt: consumedAt + 4_000, foregroundDeadlineAt: consumedAt + 4_000,
      foregroundBudgetMs: consumedAt + 3_000, remainingMs: 4_000, lateWorkCancelled: false,
      waitDisposition: "canonical-unresolved" }, `consumed at ${consumedAt}, budget ${waitBudgetMs}`);
    assert.equal(result.metadata.taskRelationOrderedResolutionCanonicalBudgetMs, 4_000);
  }
});

test("ST183-6 OR a caller whose budget covers the stage keeps its own foreground deadline (Voice and Screen)", async () => {
  const terminal = () => ({ ...handle(), affinityDeadlineAt: 5_000,
    affinityOutcome: Promise.resolve({ child: { unavailableReason: "no-active-child" },
      parent: { ...related(), settledAt: 2_900 } }),
    cancelForegroundWork: () => { throw new Error("the foreground window is still open"); } });
  const expected = { waitBudgetMs: 8_000, deadlineAt: 9_000, affinityCutoffAt: 5_000, canonicalDeadlineAt: undefined,
    foregroundDeadlineAt: 9_000, foregroundBudgetMs: 8_000, lateWorkCancelled: false, waitDisposition: "affinity-settled" };
  for (const [consumedAt, remainingMs] of [[3_000, 6_000], [5_000, 4_000]] as const) {
    // Screen: the operation derives the deadline from the stage start and the 8 s budget.
    const screen = await resolveOrderedTaskRelationWithinWindow({ handle: terminal(), traceId: "screen", sourceKind: "screen",
      currentQuestionType: "coding", activeMeetingTask, waitBudgetMs: 8_000 }, { ...dependencies, now: () => consumedAt });
    assert.deepEqual(foregroundRecord(screen.metadata), { ...expected, remainingMs });
    // Voice: the caller's own deadline object, shared with its release gate, is left as it was.
    const deadline = { startedAt: 1_000, deadlineAt: 9_000, budgetMs: 8_000 };
    const voice = await resolveOrderedTaskRelationWithinWindow({ handle: terminal(), traceId: "voice", sourceKind: "voice",
      currentQuestionType: "coding", activeMeetingTask, waitBudgetMs: 8_000, deadline }, { ...dependencies, now: () => consumedAt });
    assert.deepEqual(foregroundRecord(voice.metadata), { ...expected, remainingMs });
    assert.deepEqual(deadline, { startedAt: 1_000, deadlineAt: 9_000, budgetMs: 8_000 });
    assert.deepEqual([voice.decision.relation, screen.decision.relation], ["followup-parent", "followup-parent"]);
  }
});

// ---- ST183 P3: the wait disposition names the stage the consumer last waited for ----

test("ST183-7 OR every recorded wait disposition is one of five reachable values", async () => {
  const run = async (h: TaskRelationAdjudicationScheduleHandle) => (await resolveOrderedTaskRelationWithinWindow(
    { handle: h, traceId: "disposition", sourceKind: "screen", currentQuestionType: "coding", activeMeetingTask,
      waitBudgetMs: 8_000 }, dependencies)).metadata.taskRelationOrderedResolutionWaitDisposition;
  const settled = (parent: object) => Promise.resolve({ child: { unavailableReason: "no-active-child" }, parent });
  const canonical = { operationId: "canonical", adjudication: { schemaVersion: 3 as const, relation: "followup-parent" as const,
    confidence: 0.7, currentQuestionEvidenceSpans: ["ask"], parentEvidenceSpans: ["parent"] } };
  assert.deepEqual([
    // Resolved from the Affinity terminal: Canonical is not needed.
    await run({ ...handle(), affinityOutcome: settled(related()),
      startCanonical: () => { throw new Error("unexpected Canonical invocation"); } }),
    // Canonical was needed and its terminal carries a relation.
    await run({ ...handle(), affinityOutcome: settled(independent()), startCanonical: async () => canonical }),
    // Canonical was needed and its terminal carries none.
    await run({ ...handle(), affinityOutcome: settled(independent()),
      startCanonical: async () => ({ unavailableReason: "candidate-deadline-expired" }) }),
    // Unresolved and no Canonical started: a client error in the Affinity stage.
    await run({ ...handle(), affinityOutcome: settled({ unavailableReason: "provider-circuit-open", clientError: true }),
      startCanonical: () => { throw new Error("unexpected Canonical invocation"); } }),
    // Unresolved and no Canonical started: the handle cannot start one.
    await run({ ...handle(), affinityOutcome: settled(independent()) }),
    // No stage terminal on the handle and nothing left to decide.
    await run({ ...handle(), readAffinityOutcome: () => ({ child: { unavailableReason: "no-active-child" }, parent: related() }) }),
  ], ["affinity-settled", "canonical-settled", "canonical-unresolved", "canonical-skipped-no-budget",
    "canonical-skipped-no-budget", "affinity-unavailable"]);
});

test("ST183-2 OR a handle without a stage terminal keeps the synchronous snapshot read", async () => {
  let reads = 0;
  const h: TaskRelationAdjudicationScheduleHandle = { ...handle(),
    readAffinityOutcome: () => { reads++; return { child: { unavailableReason: "no-active-child" }, parent: independent() }; } };
  const result = await resolveOrderedTaskRelationWithinWindow({ handle: h, traceId: "snapshot", sourceKind: "screen",
    currentQuestionType: "coding", activeMeetingTask, waitBudgetMs: 8_000 }, dependencies);
  assert.ok(reads >= 1);
  assert.equal(result.metadata.taskRelationOrderedResolutionWaitDisposition, "canonical-skipped-no-budget");
  assert.equal(result.metadata.taskRelationOrderedResolutionAffinityParentDisposition, "available");
  assert.equal(result.decision.matrix.parentAffinityDecision, "independent");
});

test("ST183-3 OR the Canonical terminal is consumed whenever it settles, including at its deadline", async () => {
  let clock = 1_000;
  let release: ((outcome: { operationId: string; adjudication: object }) => void) | undefined;
  const order: string[] = [];
  const h: TaskRelationAdjudicationScheduleHandle = { ...handle(),
    affinityOutcome: Promise.resolve({ child: { unavailableReason: "no-active-child" }, parent: independent() }),
    startCanonical: () => new Promise(resolve => {
      order.push("canonical-started");
      release = outcome => { order.push("canonical-terminal"); (resolve as (value: unknown) => void)(outcome); };
    }),
    cancelForegroundWork: () => { order.push("foreground-closed"); } };
  const resolution = resolveOrderedTaskRelationWithinWindow({ handle: h, traceId: "canonical", sourceKind: "screen",
    currentQuestionType: "coding", activeMeetingTask, waitBudgetMs: 8_000 },
    { ...dependencies, now: () => clock });
  resolution.catch(() => {});
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.deepEqual(order, ["canonical-started"]);
  // The stage owner settles its terminal at the Canonical deadline (4 s after enqueue).
  clock = 5_000;
  release?.({ operationId: "canonical", adjudication: { schemaVersion: 3, relation: "followup-parent", confidence: 0.7,
    currentQuestionEvidenceSpans: ["ask"], parentEvidenceSpans: ["parent"] } });
  const result = await resolution;
  assert.equal(result.decision.stage, "canonical-relation");
  assert.equal(result.decision.relation, "followup-parent");
  assert.equal(result.metadata.taskRelationOrderedResolutionWaitDisposition, "canonical-settled");
  assert.equal(result.metadata.taskRelationOrderedResolutionCanonicalDeadlineAt, 5_000);
  assert.equal(result.metadata.taskRelationOrderedResolutionLateWorkCancelled, true);
  assert.deepEqual(order, ["canonical-started", "canonical-terminal", "foreground-closed"],
    "the foreground window closes after the Canonical selection, not before it");
});
