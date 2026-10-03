import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as metadata from "../src/lib/meeting/meeting-metadata-inference.js";
import * as repair from "../src/lib/meeting/whiteboard-syntax-repair.js";
import * as inference from "../src/lib/meeting/runtime-inference.js";
import { hashTaxonomySourceTurnIds } from "../src/lib/meeting/taxonomy-adjudication.js";
import * as health from "../src/lib/meeting/runtime-inference-health.js";
import * as admission from "../src/lib/meeting/runtime-inference-provider-admission.js";
import * as response from "../src/lib/meeting/runtime-inference-response.js";
import { RuntimeInferenceOperationRuntime } from "../src/lib/meeting/runtime-inference-runtime.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";

const source = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
const ast = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
function callback(name: string, env: object) {
  let node: ts.VariableDeclaration | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.name.getText(ast) === name) node ??= n;
    if (!node) ts.forEachChild(n, visit);
  };
  visit(ast); assert.ok(node);
  const fn = (node.initializer as ts.CallExpression).arguments[0].getText(ast);
  return vm.runInNewContext(ts.transpileModule(`(${fn})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, env);
}

// 178/168 PC: Debug and Recording no longer admit these two observations; only
// Runtime Cross-checks does. `crossCheckReads` counts how often a scheduling call
// read the switch.
function harness(debug: boolean, recording: boolean, crossChecks: boolean, knownCompany = true, mode = "shadow") {
  const turn = { id: "opening", speaker: "them", text: "Welcome to Oracle. I am the interviewer for the backend engineering role.",
    source: "system-audio", isFinal: true, startedAt: 100, endedAt: 200 };
  const context = { sessionId: "s", startedAt: 100, transcriptTurns: [turn],
    interviewSessionContext: { targetCompany: knownCompany ? { value: "Oracle", source: "manual" } : undefined } };
  const jobs: any[] = [], calls: any[] = [], writes: any[] = [];
  const observations: Record<string, unknown> = {};
  const reads = { crossChecks: 0 };
  const runtime = { getCurrentOperationId: () => undefined, schedule: (scheduled: any) => {
    jobs.push(scheduled.job);
    scheduled.onStarted?.(scheduled.job, 300, { startsBefore: 0, startsAfter: 1, remaining: 1 });
    scheduled.execute(scheduled.job, new AbortController().signal);
  } };
  const env = { ...metadata, ...repair, ...inference, hashTaxonomySourceTurnIds,
    shutdownRequestedRef: { current: false }, debugModeRef: { current: debug },
    runtimeCrossChecksEnabledRef: { get current() { reads.crossChecks += 1; return crossChecks; } },
    contextManagerRef: { current: { getState: () => context } }, runtimeEpochRef: { current: 1 },
    taxonomyAdjudicationSettingsRef: { current: { meetingMetadataMode: mode } },
    meetingModelProviderSnapshotRef: { current: {} },
    meetingMetadataInferenceCircuitRef: { current: { read: () => ({ open: false }) } },
    whiteboardSyntaxRepairCircuitRef: { current: { read: () => ({ open: false }) } },
    whiteboardSyntaxRepairAttemptKeysRef: { current: new Set() },
    meetingMetadataInferenceRuntimeRef: { current: runtime }, whiteboardSyntaxRepairRuntimeRef: { current: runtime },
    traceStoreRef: { current: { updateMetadata: (_id: string, value: object) => Object.assign(observations, value),
      recordInput() {}, startStep: () => "step" } },
    sessionRecordingManagerRef: { current: { getState: () => ({ active: recording }), recordModelInput: (value: unknown) => writes.push(value) } },
    resolveRuntimeInferenceModelRouteFromSnapshot: (route: unknown) => {
      routes.push(route);
      return { provider: { id: "provider" }, selectedProvider: { provider: "provider", variables: { model: "fixture" } } };
    },
    formatRuntimeInferenceModelRouteForTrace: () => ({}), readSelectedProviderModelId: () => "fixture",
    requestMeetingMetadataInference: (args: unknown) => calls.push(args), requestWhiteboardSyntaxRepair: (args: unknown) => calls.push(args),
  };
  const routes: unknown[] = [];
  return { env, turn, context, jobs, calls, routes, observations, writes, reads };
}
const SWITCHES = [false, true].flatMap((debug) => [false, true].flatMap((recording) =>
  [false, true].map((crossChecks) => ({ debug, recording, crossChecks }))));
const label = (switches: { debug: boolean; recording: boolean; crossChecks: boolean }) =>
  `debug=${switches.debug} recording=${switches.recording} crossChecks=${switches.crossChecks}`;
// What a request is: its arguments (prompt input, provider, budget), its job (lane, budget slot) and its route.
// A lease's wall-clock creation time and a repair's generated operation id are the fields two runs cannot share.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) =>
  key === "createdAt" ? undefined : item instanceof AbortSignal ? "signal" : typeof item === "function" ? "function"
    : typeof item === "string" ? item.replace(/^whiteboard_repair_\d+_[a-z0-9]+$/, "whiteboard_repair_<generated>") : item));
const requestOf = (h: ReturnType<typeof harness>) => plain({ calls: h.calls, jobs: h.jobs, routes: h.routes });

const invalidWhiteboard = () => ({
  validation: { valid: false, candidateKind: "mermaid", operationId: "validation", candidateFingerprint: "fp", parserErrorClass: "parse-error" },
  parent: { id: "p", revisions: 1, whiteboardArtifact: { id: "wb", renderState: {
    validationOperationId: "validation", candidateFingerprint: "fp", candidateRevision: 2, visibleRevision: 1 } } },
  candidateWhiteboard: "```mermaid\nflowchart TD\nA --> B\nend\n```",
});
// Candidates the repair observation never starts for: not an invalid Mermaid
// candidate, or no longer the parent's current candidate (stale).
const INELIGIBLE_WHITEBOARD = [
  ["a valid candidate", { validation: { ...invalidWhiteboard().validation, valid: true } }],
  ["a candidate that is not Mermaid", { validation: { ...invalidWhiteboard().validation, candidateKind: "ascii" } }],
  ["a validation that is no longer the current one", { validation: { ...invalidWhiteboard().validation, operationId: "older" } }],
  ["a candidate whose fingerprint is no longer the current one", { validation: { ...invalidWhiteboard().validation, candidateFingerprint: "older" } }],
  ["no parent", { parent: undefined }],
] as const;
const scheduleRepair = (h: ReturnType<typeof harness>, input: Record<string, unknown> = {}) =>
  callback("scheduleWhiteboardSyntaxRepairShadow", h.env)({ traceId: "trace", source: "voice", ...invalidWhiteboard(), ...input });
const scheduleMetadata = (h: ReturnType<typeof harness>) =>
  callback("scheduleMeetingMetadataInference", h.env)({ turn: h.turn, traceId: "trace" });

// PC2: the original eligibility is fixed (bounded opening evidence and a target
// company that already exists; an invalid Mermaid candidate that is still the
// current one), and Debug x Recording x Cross-checks are crossed.
for (const switches of SWITCHES) {
  const { debug, recording, crossChecks } = switches;
  test(`PC2 D178 known-company Metadata cross-check ${label(switches)}`, () => {
    for (const mode of ["shadow", "enforcement"]) {
      const h = harness(debug, recording, crossChecks, true, mode);
      scheduleMetadata(h);
      assert.equal(h.calls.length, crossChecks ? 1 : 0, `physical requests in ${mode}`);
      assert.equal(h.jobs.length, h.calls.length, "one logical operation per physical request");
      assert.equal(h.reads.crossChecks, 1, "the switch is read once, at the start");
      if (crossChecks) {
        assert.equal(h.observations.meetingMetadataInferenceObservationTrigger, "runtime-cross-checks");
        assert.equal(h.observations.meetingMetadataInferenceDisposition, "scheduled");
        assert.equal(h.observations.meetingMetadataInferenceMode, mode, "the feature's own mode still applies");
        assert.ok(h.observations.meetingMetadataInferenceOperationId);
        assert.equal(h.observations.meetingMetadataInferenceBudgetStartsAfter, 1);
        assert.equal(h.jobs[0].operationKind, "meeting-metadata-inference");
      } else {
        // Off is a named skip, distinct from an ineligible turn and from a failed request.
        assert.equal(h.observations.meetingMetadataInferenceDisposition, "authoritative-observation-disabled");
        assert.equal(h.observations.meetingMetadataInferenceSkipReason, "runtime-cross-checks-off");
        assert.equal(h.observations.meetingMetadataInferenceObservationTrigger, undefined);
        assert.equal(h.observations.meetingMetadataInferenceEligible, true);
      }
    }
    // On, the original eligibility still decides: a turn outside the opening evidence starts nothing.
    const ineligible = harness(debug, recording, crossChecks);
    ineligible.context.transcriptTurns = [];
    scheduleMetadata(ineligible);
    assert.equal(ineligible.calls.length, 0);
    assert.equal(ineligible.observations.meetingMetadataInferenceDisposition, "ineligible");
    assert.equal(ineligible.reads.crossChecks, 0);
  });

  test(`PC2 D178 invalid Whiteboard observation ${label(switches)}`, () => {
    const h = harness(debug, recording, crossChecks);
    scheduleRepair(h);
    assert.equal(h.calls.length, crossChecks ? 1 : 0, "physical requests");
    assert.equal(h.jobs.length, h.calls.length, "one logical operation per physical request");
    assert.equal(h.reads.crossChecks, 1, "the switch is read once, at the start");
    if (crossChecks) {
      assert.equal(h.observations.whiteboardRepairObservationTrigger, "runtime-cross-checks");
      assert.equal(h.jobs[0].operationKind, "whiteboard-syntax-repair");
      assert.ok(h.jobs[0].lease);
    } else {
      // Off is a named skip and nothing else: no repair is recorded as attempted.
      assert.deepEqual(h.observations, { whiteboardRepairObservationSkipReason: "runtime-cross-checks-off" },
        "only the named skip is recorded");
    }
    // On, the original eligibility still decides.
    for (const [why, input] of INELIGIBLE_WHITEBOARD) {
      const ineligible = harness(debug, recording, crossChecks);
      scheduleRepair(ineligible, input);
      assert.equal(ineligible.calls.length, 0, why);
    }
  });
}

// Brief section 7: switch-off must be distinguishable from an ineligible or stale
// candidate. Only a candidate that was otherwise eligible records the named skip;
// the skip starts no request, logical operation, route lookup, step or input record.
test("PC2 Whiteboard skip record: eligible with Cross-checks off records the named skip and starts nothing; ineligible or stale records nothing; eligible with Cross-checks on sends the request under its trigger with no skip", () => {
  const SKIP = "whiteboardRepairObservationSkipReason";
  for (const switches of SWITCHES) {
    const h = harness(switches.debug, switches.recording, switches.crossChecks);
    let steps = 0, inputs = 0;
    h.env.traceStoreRef.current.startStep = () => { steps += 1; return "step"; };
    h.env.traceStoreRef.current.recordInput = () => { inputs += 1; };
    scheduleRepair(h);
    if (switches.crossChecks) {
      assert.equal(h.calls.length, 1, `${label(switches)}: one request`);
      assert.equal(h.observations.whiteboardRepairObservationTrigger, "runtime-cross-checks", label(switches));
      assert.equal(SKIP in h.observations, false, `${label(switches)}: no skip key on an admitted repair`);
    } else {
      assert.deepEqual(h.observations, { [SKIP]: "runtime-cross-checks-off" }, `${label(switches)}: the named skip and no other key`);
      assert.deepEqual([h.calls.length, h.jobs.length, h.routes.length, steps, inputs, h.writes.length], [0, 0, 0, 0, 0, 0],
        `${label(switches)}: requests, operations, route lookups, steps, trace inputs and recorder writes`);
    }
    // An ineligible or stale candidate records nothing, whatever the switch says.
    for (const [why, input] of INELIGIBLE_WHITEBOARD) {
      const ineligible = harness(switches.debug, switches.recording, switches.crossChecks);
      scheduleRepair(ineligible, input);
      assert.deepEqual(ineligible.observations, {}, `${label(switches)}: ${why} records nothing`);
      assert.deepEqual([ineligible.calls.length, ineligible.jobs.length], [0, 0], `${label(switches)}: ${why} starts nothing`);
    }
  }
});

test("PC4 Metadata with no company follows the feature's own mode: one request, never duplicated or blocked by Cross-checks, identical under every switch", () => {
  for (const mode of ["shadow", "enforcement"]) {
    let frozen: unknown;
    for (const switches of SWITCHES) {
      const product = harness(switches.debug, switches.recording, switches.crossChecks, false, mode);
      scheduleMetadata(product);
      assert.equal(product.calls.length, 1, `${mode} ${label(switches)}: exactly one request`);
      assert.equal(product.jobs.length, 1);
      assert.equal(product.reads.crossChecks, 0, "the empty-company path never reads the switch");
      assert.equal(product.observations.meetingMetadataInferenceObservationTrigger, undefined);
      assert.equal(product.observations.meetingMetadataInferenceMode, mode);
      // Prompt input, provider, budget, lane and route are byte-identical across the eight combinations.
      frozen ??= requestOf(product);
      assert.deepEqual(requestOf(product), frozen, `${mode} ${label(switches)}`);
    }
  }
});

test("PC4 Metadata explicit off keeps priority and its own recorded reason; Cross-checks cannot re-enable it", () => {
  for (const switches of SWITCHES) {
    // No company: the feature is off.
    const empty = harness(switches.debug, switches.recording, switches.crossChecks, false, "off");
    scheduleMetadata(empty);
    assert.equal(empty.calls.length, 0, label(switches));
    assert.deepEqual([empty.observations.meetingMetadataInferenceDisposition, empty.observations.meetingMetadataInferenceSkipReason],
      ["operation-disabled", "runtime-inference-disabled"]);
    assert.equal(empty.reads.crossChecks, 0);
    // A company exists: still no request, and the stored off is what is recorded, under its
    // unchanged reason, whether Cross-checks is on or off.
    const known = harness(switches.debug, switches.recording, switches.crossChecks, true, "off");
    scheduleMetadata(known);
    assert.equal(known.calls.length, 0, label(switches));
    assert.deepEqual([known.observations.meetingMetadataInferenceDisposition, known.observations.meetingMetadataInferenceSkipReason],
      ["operation-disabled", "runtime-inference-disabled"], label(switches));
  }
});

// The four known-company cells: stored mode {off, not off} x Cross-checks {off, on}.
// Each row is [recorded disposition, recorded skip reason, physical requests].
test("PC4 known-company Metadata, stored mode x Cross-checks: a stored off wins with its own reason; any other mode is a Cross-checks skip with the switch off and one request with it on", () => {
  const cell = (switches: (typeof SWITCHES)[number], mode: string) => {
    const h = harness(switches.debug, switches.recording, switches.crossChecks, true, mode);
    scheduleMetadata(h);
    assert.equal(h.observations.meetingMetadataInferenceMode, mode, "the stored mode is on the trace");
    assert.equal(h.jobs.length, h.calls.length, "one logical operation per physical request");
    return { outcome: [h.observations.meetingMetadataInferenceDisposition, h.observations.meetingMetadataInferenceSkipReason, h.calls.length],
      trigger: h.observations.meetingMetadataInferenceObservationTrigger };
  };
  for (const switches of SWITCHES) {
    // Stored off, switch off and switch on: the off reason, never the Cross-checks reason.
    const off = cell(switches, "off");
    assert.deepEqual(off.outcome, ["operation-disabled", "runtime-inference-disabled", 0], `off ${label(switches)}`);
    assert.equal(off.trigger, undefined, `off ${label(switches)}`);
    for (const mode of ["shadow", "enforcement"]) {
      const admitted = cell(switches, mode);
      assert.deepEqual(admitted.outcome, switches.crossChecks ? ["scheduled", undefined, 1]
        : ["authoritative-observation-disabled", "runtime-cross-checks-off", 0], `${mode} ${label(switches)}`);
      assert.equal(admitted.trigger, switches.crossChecks ? "runtime-cross-checks" : undefined, `${mode} ${label(switches)}`);
    }
  }
});

test("PC4 the known-company cross-check and the Whiteboard observation send the same request whatever Debug and Recording say", () => {
  let metadataRequest: unknown, repairRequest: unknown;
  for (const switches of SWITCHES.filter((candidate) => candidate.crossChecks)) {
    const known = harness(switches.debug, switches.recording, true, true, "shadow");
    scheduleMetadata(known);
    metadataRequest ??= requestOf(known);
    assert.deepEqual(requestOf(known), metadataRequest, label(switches));
    const repaired = harness(switches.debug, switches.recording, true);
    scheduleRepair(repaired);
    repairRequest ??= requestOf(repaired);
    assert.deepEqual(requestOf(repaired), repairRequest, label(switches));
  }
});

// ---------------------------------------------------------------------------
// PC6: a known-company cross-check already in flight when something changes.
// The Hook's real scheduling callback with the real operation runtime, lease,
// parser, comparison, commit decision and context manager. Only the physical
// provider request and the sinks are substituted.
// ---------------------------------------------------------------------------
function inFlightMetadata(mode: "shadow" | "enforcement", { knownCompany = true, switchedOn = true,
  coordinator }: { knownCompany?: boolean; switchedOn?: boolean; coordinator?: admission.RuntimeInferenceProviderAdmissionCoordinator } = {}) {
  const manager = new MeetingContextManager();
  const startedAt = manager.getState().startedAt;
  const opening = { id: "opening", speaker: "them" as const, text: "I am the recruiter from Oracle.", source: "system-audio" as const,
    isFinal: true, startedAt: startedAt + 1_000, endedAt: startedAt + 1_500 };
  manager.addTranscriptTurn(opening);
  // The target company already exists: it came from the Brief.
  if (knownCompany) {
    manager.setInterviewSessionBrief({ targetCompany: "Google", targetCompanyNormalized: "google", companyLocked: true, interviewTypes: [] });
  }
  const crossChecks = { current: switchedOn };
  const runtimeEpoch = { current: 1 };
  const runtime = new RuntimeInferenceOperationRuntime<any, any>("meeting-metadata-inference", coordinator);
  const requests: Array<{ args: any; answer: (rawOutput: string) => void }> = [];
  const trace: Record<string, unknown> = {};
  const stateUpdates: unknown[] = [], decisions: any[] = [], steps: unknown[][] = [];
  let commits = 0;
  const commit = manager.commitRuntimeInferredTargetCompany.bind(manager);
  manager.commitRuntimeInferredTargetCompany = (input) => { commits += 1; return commit(input); };
  const env = { ...metadata, ...inference, ...health, ...admission, ...response, hashTaxonomySourceTurnIds, Date,
    shutdownRequestedRef: { current: false }, debugModeRef: { current: false }, runtimeCrossChecksEnabledRef: crossChecks,
    contextManagerRef: { current: manager }, runtimeEpochRef: runtimeEpoch,
    taxonomyAdjudicationSettingsRef: { current: { meetingMetadataMode: mode } },
    meetingModelProviderSnapshotRef: { current: {} },
    meetingMetadataInferenceCircuitRef: { current: new health.RuntimeInferenceSessionCircuitBreaker() },
    meetingMetadataInferenceRuntimeRef: { current: runtime },
    traceStoreRef: { current: { updateMetadata: (_id: string, value: object) => Object.assign(trace, value), recordInput() {}, recordOutput() {},
      startStep: () => "step", finishStep: (...args: unknown[]) => steps.push(args) } },
    sessionRecordingManagerRef: { current: { getState: () => ({ active: true }), recordModelInput() {}, recordModelOutput() {},
      recordMeetingMetadataInferenceDecision: (value: any) => decisions.push(value) } },
    resolveRuntimeInferenceModelRouteFromSnapshot: () => ({ provider: { id: "provider" },
      selectedProvider: { provider: "provider", variables: { model: "fixture" } }, missingRequiredVariables: [] }),
    formatRuntimeInferenceModelRouteForTrace: () => ({}), readSelectedProviderModelId: () => "fixture",
    // The provider answers when the test says so; the output goes through the real parser.
    requestMeetingMetadataInference: (args: any) => new Promise((resolve) => {
      requests.push({ args, answer: (rawOutput) => resolve({ rawOutput, providerDisposition: "completed-with-content",
        parseDisposition: "valid-json", parsed: metadata.parseMeetingMetadataInferenceOutput(rawOutput, args.request) }) });
    }),
    setState: (update: unknown) => stateUpdates.push(update),
  };
  const schedule = callback("scheduleMeetingMetadataInference", env);
  return { manager, opening, crossChecks, runtimeEpoch, runtime, requests, trace, stateUpdates, decisions, steps,
    get commits() { return commits; }, schedule: (turn = opening) => schedule({ turn, traceId: "trace" }) };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
// A grounded, confident proposal for a company other than the one that exists.
const conflictingCompany = JSON.stringify({ schemaVersion: 1, company: "Oracle", confidence: 0.98,
  evidenceSpans: ["recruiter from Oracle"], abstainReason: null });

for (const mode of ["shadow", "enforcement"] as const) {
  for (const [change, apply, disposition, mutation] of [
    ["Cross-checks is switched off", (h: ReturnType<typeof inFlightMetadata>) => { h.crossChecks.current = false; },
      "shadow-observed", mode === "enforcement" ? "blocked-company-already-resolved" : "blocked-mode-not-enforcement"],
    ["the runtime epoch changes", (h: ReturnType<typeof inFlightMetadata>) => { h.runtimeEpoch.current += 1; },
      "stale", mode === "enforcement" ? "blocked-lease-not-authorized" : "blocked-mode-not-enforcement"],
    ["the session changes", (h: ReturnType<typeof inFlightMetadata>) => { h.manager.reset({ sessionId: "session-next" }); },
      "stale", mode === "enforcement" ? "blocked-lease-not-authorized" : "blocked-mode-not-enforcement"],
  ] as const) {
    test(`PC6 a known-company Metadata cross-check in flight in ${mode} mode when ${change} reaches a real terminal and writes no company`, async (t) => {
      const h = inFlightMetadata(mode);
      t.after(() => h.runtime.cancelAll("disposed"));
      const companyBefore = structuredClone(h.manager.getState().interviewSessionContext?.targetCompany);
      assert.equal(companyBefore?.value, "Google");
      h.schedule();
      await tick();
      assert.equal(h.requests.length, 1, "request in flight");
      assert.deepEqual([h.trace.meetingMetadataInferenceDisposition, h.trace.meetingMetadataInferenceObservationTrigger],
        ["scheduled", "runtime-cross-checks"]);
      apply(h);
      const companyAfterChange = structuredClone(h.manager.getState().interviewSessionContext?.targetCompany);
      h.requests[0]!.answer(conflictingCompany);
      await tick();
      // A real terminal, with the start-time trigger kept.
      assert.deepEqual([h.trace.meetingMetadataInferenceDisposition, h.trace.meetingMetadataInferenceObservationTrigger,
        h.trace.meetingMetadataInferenceParseValid, h.steps.length, h.decisions.length],
      [disposition, "runtime-cross-checks", true, 1, 1]);
      // Read-only: no commit, no state update, the company is what it was.
      assert.deepEqual([h.trace.meetingMetadataInferenceCommitAuthorized, h.trace.meetingMetadataInferenceMutationDisposition,
        h.trace.meetingMetadataInferenceAppliedToRuntime, h.commits, h.stateUpdates.length],
      [false, mutation, false, 0, 0]);
      assert.deepEqual(h.manager.getState().interviewSessionContext?.targetCompany, companyAfterChange);
      if (change === "Cross-checks is switched off") {
        assert.deepEqual(companyAfterChange, companyBefore);
        // A later opening turn is a new observation: it is not started.
        const next = { ...h.opening, id: "opening-2", text: "We are hiring for the Oracle cloud team.", startedAt: h.opening.startedAt + 2_000,
          endedAt: h.opening.startedAt + 2_500 };
        h.manager.addTranscriptTurn(next);
        h.schedule(next);
        await tick();
        assert.equal(h.requests.length, 1, "requests after the switch-off");
        assert.deepEqual([h.trace.meetingMetadataInferenceDisposition, h.trace.meetingMetadataInferenceSkipReason],
          ["authoritative-observation-disabled", "runtime-cross-checks-off"]);
      }
    });
  }
}

// The control for the tests above: the same harness does commit when the feature's
// own contract says so. With no company, enforcement fills it, and that request
// is not behind the switch.
test("PC4 PC6 control: with no company the enforcement fill still runs and commits with Cross-checks off, in the harness that shows no write above", async (t) => {
  const h = inFlightMetadata("enforcement", { knownCompany: false, switchedOn: false });
  t.after(() => h.runtime.cancelAll("disposed"));
  assert.equal(h.manager.getState().interviewSessionContext?.targetCompany, undefined);
  h.schedule();
  await tick();
  assert.equal(h.requests.length, 1, "the empty-company request is not behind the switch");
  assert.equal(h.trace.meetingMetadataInferenceObservationTrigger, undefined);
  h.requests[0]!.answer(conflictingCompany);
  await tick();
  assert.deepEqual([h.trace.meetingMetadataInferenceDisposition, h.trace.meetingMetadataInferenceCommitAuthorized,
    h.trace.meetingMetadataInferenceMutationDisposition, h.commits, h.stateUpdates.length],
  ["enforcement-committed", true, "committed-unresolved-company", 1, 1]);
  assert.equal(h.manager.getState().interviewSessionContext?.targetCompany?.value, "Oracle");
});

// The Hook's coordinator holds a non-critical request for 450 ms before it is
// dispatched. The clock here is the coordinator's own injected clock, stepped by hand.
test("PC6 admission grace: a known-company cross-check admitted before the switch went off is still sent when the grace ends, and writes no company", async (t) => {
  let now = 1_000;
  const timers: Array<{ at: number; run: () => void }> = [];
  const clock = { now: () => now, schedule: (run: () => void, delayMs: number) => { const timer = { at: now + delayMs, run }; timers.push(timer); return timer; },
    cancel: (timer: unknown) => { const index = timers.indexOf(timer as (typeof timers)[number]); if (index >= 0) timers.splice(index, 1); } };
  const advanceTo = (at: number) => {
    now = at;
    for (const timer of timers.filter((candidate) => candidate.at <= at)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.run();
    }
  };
  // The production settings: three slots and a 450 ms grace.
  const h = inFlightMetadata("enforcement", { coordinator: new admission.RuntimeInferenceProviderAdmissionCoordinator(3, 450, clock) });
  t.after(() => h.runtime.cancelAll("disposed"));
  h.schedule();
  await tick();
  assert.deepEqual([h.requests.length, h.trace.meetingMetadataInferenceDisposition, h.trace.meetingMetadataInferenceObservationTrigger],
    [0, "scheduled", "runtime-cross-checks"], "admitted and waiting out the grace");
  h.crossChecks.current = false;
  advanceTo(1_449);
  await tick();
  assert.equal(h.requests.length, 0, "requests before the grace ends");
  // Switching off is not a canceller: the admitted request goes out when the grace ends.
  advanceTo(1_450);
  await tick();
  assert.equal(h.requests.length, 1, "requests when the grace ends");
  h.requests[0]!.answer(conflictingCompany);
  await tick();
  assert.deepEqual([h.trace.meetingMetadataInferenceDisposition, h.trace.meetingMetadataInferenceObservationTrigger,
    h.trace.meetingMetadataInferenceMutationDisposition, h.commits, h.stateUpdates.length],
  ["shadow-observed", "runtime-cross-checks", "blocked-company-already-resolved", 0, 0]);
  assert.equal(h.manager.getState().interviewSessionContext?.targetCompany?.value, "Google");
});
