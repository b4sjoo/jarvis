import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { SessionRecordingManager, type SessionRecordingInvoke } from "../src/lib/meeting/session-recording.js";
import type { MeetingAssistantSettings } from "../src/lib/meeting/types.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { createAdvisorTriggerJob, decideAdvisorJobCommit } from "../src/lib/meeting/advisor-trigger-job.js";
import { buildSettledAdvisorExecutionPlan } from "../src/lib/meeting/settled-advisor-execution-plan.js";

const recorderPath = "src/lib/meeting/session-recording.ts";
const baselineRevision = "20332a81383e2c125af7ee8db8472d1065a99acf";
const options = {
  meetingSessionId: "bounded-meeting",
  settings: {
    codingModel: { enabled: false, provider: "", variables: {} },
    taxonomyAdjudication: { enabled: true, provider: "", variables: {} },
  } as unknown as MeetingAssistantSettings,
  providerSummary: {
    hasMainProvider: false, hasCodingProvider: false, hasTaxonomyAdjudicationProvider: false,
    hasSttProvider: false, mainSupportsImages: false, codingSupportsImages: false,
  },
};

// Both revisions execute unmodified production Manager source with identical current
// dependencies and temp I/O. This measures the recorder, not Hook reset, IPC or native fs.
async function loadRecorder(source: string): Promise<typeof SessionRecordingManager> {
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const parsed = ts.createSourceFile("recorder.js", javascript, ts.ScriptTarget.Latest, true);
  const modules = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const argument = node.arguments[0];
      assert.ok(argument && ts.isStringLiteral(argument));
      modules.add(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  const dependencies: Record<string, unknown> = {};
  for (const name of modules) {
    if (name === "@tauri-apps/api/core") {
      dependencies[name] = { invoke: () => { throw new Error("Native I/O is forbidden in this fixture"); } };
    } else {
      assert.ok(name.startsWith("./"), name);
      const file = name.endsWith(".js") ? name : `${name}.js`;
      dependencies[name] = await import(new URL(`../src/lib/meeting/${file.slice(2)}`, import.meta.url).href);
    }
  }
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(javascript, {
    exports, console, Date, Promise, Set, Map, Error, JSON,
    require: (name: string) => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; },
  });
  return exports.SessionRecordingManager as typeof SessionRecordingManager;
}

class TemporaryRecordingIO {
  writes = 0;
  bytes = 0;
  failTerminal = false;
  terminalPayloads: string[] = [];
  private serial = 0;
  private barrierRelease?: () => void;
  constructor(readonly root: string, readonly atomicManifest: boolean) {}

  private async write(file: string, payload: string | Buffer, append = false) {
    await mkdir(path.dirname(file), { recursive: true });
    if (this.atomicManifest && path.basename(file) === "manifest.json" && !append) {
      const temporary = `${file}.${++this.serial}.tmp`;
      await writeFile(temporary, payload);
      await rename(temporary, file);
    } else if (append) await appendFile(file, payload);
    else await writeFile(file, payload);
    this.writes++;
    this.bytes += Buffer.byteLength(payload);
  }

  invoke: SessionRecordingInvoke = async <T>(command: string, args: Record<string, unknown> = {}) => {
    const folder = path.join(this.root, String(args.folderName));
    if (command === "start_meeting_session_recording") {
      await this.write(path.join(folder, "manifest.json"), String(args.manifestPayload));
      await this.write(path.join(folder, "README.md"), String(args.readmePayload));
      return folder as T;
    }
    assert.ok(command === "write_meeting_session_recording_text" || command === "write_meeting_session_recording_base64", command);
    const relative = String(args.relativePath);
    const payload = command === "write_meeting_session_recording_base64"
      ? Buffer.from(String(args.base64Payload), "base64") : String(args.payload);
    if (relative === "manifest.json" && JSON.parse(String(payload)).status === "stopped") {
      this.terminalPayloads.push(String(payload));
      if (this.failTerminal) throw new Error("controlled terminal publication failure");
    }
    await this.write(path.join(folder, relative), payload, args.append === true);
    if (relative === "timeline.jsonl" && String(payload).includes('"label":"workload-end"')) {
      this.barrierRelease?.();
      this.barrierRelease = undefined;
    }
    return undefined as T;
  };

  async barrier(manager: SessionRecordingManager) {
    const completed = new Promise<void>((resolve) => { this.barrierRelease = resolve; });
    manager.recordModelOutput({ traceId: "barrier", label: "workload-end", value: "drain accepted writes" });
    await completed;
  }
}

function enqueueWorkload(manager: SessionRecordingManager) {
  const startedAt = Date.now();
  for (let i = 0; i < 32; i++) {
    manager.recordTranscriptTurn({ id: `turn-${i}`, text: "Synthetic local transcript. ".repeat(16),
      speaker: "them", startedAt, endedAt: startedAt + 1, isFinal: true, source: "system-audio" });
    manager.recordModelInput({ traceId: `trace-${i}`, label: "advisor", value: "p".repeat(2048) });
    manager.recordModelOutput({ traceId: `trace-${i}`, label: "advisor", value: "a".repeat(1024) });
  }
  for (let i = 0; i < 4; i++) {
    manager.recordScreenCapture({ id: `screen-${i}`, capturedAt: startedAt, source: "hotkey", changed: true,
      imageMediaType: "image/png", imageBase64: Buffer.alloc(16_384, i).toString("base64") });
  }
}

interface Sample {
  startupMs: number;
  enqueueMs: number;
  recordMs: number;
  stopMs: number;
  retryMs: number;
  recordsPerSecond: number;
  bytesPerSecond: number;
  recordBytes: number;
  recordWrites: number;
}

async function measure(Recorder: typeof SessionRecordingManager, atomic: boolean, failure: boolean): Promise<Sample> {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-recording-workload-"));
  const io = new TemporaryRecordingIO(directory, atomic);
  const manager = new Recorder(undefined, io.invoke);
  try {
    const start = performance.now();
    const recording = await manager.start(options);
    const startupMs = performance.now() - start;
    await io.barrier(manager);
    const initialBytes = io.bytes;
    const initialWrites = io.writes;
    const activeStart = performance.now();
    enqueueWorkload(manager);
    const enqueueMs = performance.now() - activeStart;
    await io.barrier(manager);
    const recordMs = performance.now() - activeStart;
    const recordBytes = io.bytes - initialBytes;
    const recordWrites = io.writes - initialWrites;
    const folder = recording.folderPath!;
    const turns = (await readFile(path.join(folder, "transcripts/turns.jsonl"), "utf8")).trim().split("\n");
    assert.equal(turns.length, 32);
    assert.equal(JSON.parse(turns[31]!).id, "turn-31");
    assert.equal((await readFile(path.join(folder, "screenshots/screen-0.png"))).byteLength, 16_384);
    io.failTerminal = failure;
    const stopStart = performance.now();
    if (failure) await assert.rejects(manager.stop(), /controlled terminal publication failure/);
    else await manager.stop();
    const stopMs = performance.now() - stopStart;
    let retryMs = 0;
    if (failure) {
      assert.equal(manager.getState().active, false);
      const writes = io.writes;
      io.failTerminal = false;
      const retryStart = performance.now();
      await manager.stop("retry");
      retryMs = performance.now() - retryStart;
      if (atomic) {
        assert.equal(io.writes, writes + 1);
        assert.equal(io.terminalPayloads.length, 2);
        assert.equal(io.terminalPayloads[0], io.terminalPayloads[1]);
      } else {
        // Historical loss of ownership makes old Stop a no-op, not a successful retry.
        assert.equal(io.writes, writes);
        assert.equal(io.terminalPayloads.length, 1);
      }
    }
    const manifest = JSON.parse(await readFile(path.join(folder, "manifest.json"), "utf8"));
    if (!failure || atomic) {
      assert.equal(manifest.status, "stopped");
      assert.equal(manifest.recordingIntegrity.status, "complete");
      assert.equal(manifest.recordingIntegrity.failedWriteCount, 0);
    } else assert.equal(manifest.status, "running");
    return { startupMs, enqueueMs, recordMs, stopMs, retryMs,
      recordsPerSecond: 100_000 / recordMs, bytesPerSecond: recordBytes * 1000 / recordMs,
      recordBytes, recordWrites };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
  return { n: sorted.length, median: at(0.5), p95: at(0.95), min: sorted[0], max: sorted.at(-1), iqr: at(0.75) - at(0.25) };
}

test("RG1: matched production Recorder/temp-I/O workload, historical retry is explicitly nonfunctional", {
  timeout: 120_000,
  skip: process.env.JARVIS_RECORDING_PERFORMANCE === "1"
    ? false
    : "Opt in with JARVIS_RECORDING_PERFORMANCE=1; historical benchmark requires baseline commit 20332a8 (not a shallow-checkout gate).",
}, async (t) => {
  const baselineSource = execFileSync("git", ["show", `${baselineRevision}:${recorderPath}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const candidateSource = readFileSync(recorderPath, "utf8");
  const candidateRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const constructors = { baseline: await loadRecorder(baselineSource), candidate: await loadRecorder(candidateSource) };
  t.diagnostic(JSON.stringify({ baselineRevision, candidateRevision, candidateSourceHash: createHash("sha256").update(candidateSource).digest("hex"),
    boundary: "production Manager revisions share current JS dependencies, not full historical apps; Node temporary-file I/O, no Hook/IPC/native/device/provider",
    workload: "32 transcript + 32 prompt(2KiB) + 32 output(1KiB) + 4 binary screen(16KiB); final production queue sentinel",
    warmupsPerRevisionAndOutcome: 3, measuredPairsPerOutcome: 24, order: "alternating AB/BA", retryBaseline: "unsupported: old owner lost, Stop is no-op" }));
  for (const failure of [false, true]) {
    const samples: Record<"baseline" | "candidate", Sample[]> = { baseline: [], candidate: [] };
    for (let pair = -3; pair < 24; pair++) {
      const order = pair % 2 === 0 ? ["baseline", "candidate"] as const : ["candidate", "baseline"] as const;
      for (const version of order) {
        const sample = await measure(constructors[version], version === "candidate", failure);
        if (pair >= 0) samples[version].push(sample);
      }
    }
    assert.deepEqual(samples.baseline.map((s) => s.recordWrites), samples.candidate.map((s) => s.recordWrites));
    assert.deepEqual(samples.baseline.map((s) => s.recordBytes), samples.candidate.map((s) => s.recordBytes));
    for (const version of ["baseline", "candidate"] as const) {
      const measured = samples[version];
      const statistics = Object.fromEntries((Object.keys(measured[0]!) as Array<keyof Sample>).map((key) => [key, summary(measured.map((s) => s[key]))]));
      t.diagnostic(JSON.stringify({ outcome: failure ? "failed-close/retry" : "normal-close", version, statistics, samples: measured }));
    }
  }
});

test("RC3: retained failed recorder does not alter settled Job/Plan to actual pending publication callbacks", async () => {
  // Reuse the existing callback harness without copying it or registering its tests.
  // Its adapter stubs UI/observers; its production prepare/install/finalize callbacks
  // and Stable/lease/ledger implementations remain intact. No provider is called.
  const harnessSource = readFileSync("tests/pending-answer-publication-callback.test.mjs", "utf8");
  const parsed = ts.createSourceFile("pending.mjs", harnessSource, ts.ScriptTarget.Latest, true);
  const firstTest = parsed.statements.find((node) => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(parsed) === "test");
  assert.ok(firstTest);
  const harnessModule = await import(`data:text/javascript;base64,${Buffer.from(
    harnessSource.slice(0, firstTest.getStart(parsed)) + "\nexport { createHarness, lease, suggestion };\n"
  ).toString("base64")}`);
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  for (const stale of [false, true]) {
    let expected: unknown;
    for (const mode of ["disabled", "active", "close-failed"] as const) {
      const directory = await mkdtemp(path.join(tmpdir(), "jarvis-recording-publication-"));
      const io = new TemporaryRecordingIO(directory, true);
      const manager = new SessionRecordingManager(undefined, io.invoke);
      const h = harnessModule.createHarness();
      try {
        if (mode !== "disabled") {
          await manager.start(options);
          if (mode === "close-failed") {
            io.failTerminal = true;
            await assert.rejects(manager.stop(), /controlled terminal publication failure/);
            assert.equal(manager.getState().lifecycle, "close-failed");
            assert.equal(manager.getState().active, false);
          }
        }
        const retained = plain(manager.getState());
        const writesBefore = io.writes;
        const context = new MeetingContextManager();
        context.reset({ sessionId: "session-a" });
        const seed = context.commitTaskRuntimeTransition({
          id: "recording-fixture-parent", transition: "create-parent", expectedRevision: 0,
          reason: "test-seed-task-runtime", parent: {
          id: "parent-a", source: "voice", stableKind: "coding", topic: "Explain the queue invariant",
          playbookPhase: "baseline_reasoning", phaseProgress: {}, supportedFactAnchors: [],
          revisions: 1, createdAt: 1000, updatedAt: 1000,
        } });
        assert.equal(seed.authorized, true);
        h.environment.contextManagerRef.current = context;
        h.environment.sessionRecordingManagerRef.current = manager;
        let observerCalls = 0;
        const recordLifecycle = manager.recordCaptureLifecycle.bind(manager);
        manager.recordCaptureLifecycle = (...args: Parameters<typeof recordLifecycle>) => {
          observerCalls++;
          return recordLifecycle(...args);
        };
        const before = plain(context.getState());
        const task = context.getState().activeMeetingTask!;
        const job = createAdvisorTriggerJob({
          source: "regenerate", mode: "regenerate", sessionId: "session-a", runtimeEpoch: 1,
          snapshotTurnCount: 1, taskMutationAuthority: "output-only-current-branch", scheduledAt: 2000,
          promptContext: { transcript: "Explain the queue invariant", screenContext: "", rollingSummary: "",
            userProfileContext: "", glossaryText: "", activeMeetingTask: task, taskRuntime: context.getTaskRuntimeState() },
        });
        const plan = buildSettledAdvisorExecutionPlan({
          settlement: {
            settlementId: "settlement-b", logicalQuestionUnitId: "lqu-current", revision: 1,
            sessionId: job.expectedSessionId, runtimeEpoch: job.runtimeCommitToken.runtimeEpoch,
            sourceKind: "voice", sourceTurnIds: ["turn-current"], sourceObservationIds: [], sourceHash: "source-b",
            questionType: "coding", relation: "followup-parent", action: "answer", evidenceMode: "unknown",
            authority: "deterministic-fast-path", authoritySource: "accepted-transcript",
            typeAuthoritySource: "deterministic-fast-path", relationAuthoritySource: "deterministic-fast-path",
            actionAuthoritySource: "deterministic-fast-path", typeMutationAuthorized: false,
            relationMutationAuthorized: false, parentMutationAuthorized: false, responseAuthorized: true,
            confidence: 0.95, manualCorrectionRevision: 0, rejectedProposals: [], reasons: ["response-authorized"],
          },
          activeMeetingTask: task, taskBoundaryCommitted: false, childOwnsResponse: false,
          providerSnapshot: { providers: [{ id: "fixture", curl: "https://fixture.invalid" }],
            selectedProvider: { provider: "fixture", variables: {} }, codingProvider: { provider: "", variables: {} } },
          memoryUseCase: "coding_interview", askFrame: "direct-answer", topicDomain: "backend",
          artifactRequest: { hardAnswerOnly: true }, createdAt: 2000,
        });
        const authorized = decideAdvisorJobCommit({ job, activeJobId: job.id,
          currentRuntime: { sessionId: "session-a", runtimeEpoch: 1, parentId: task.parent.id, parentRevision: task.parent.revisions } });
        assert.equal(authorized.authorized, true);
        assert.deepEqual(plan.requestedArtifacts, ["answer"]);
        const generationLease = { ...harnessModule.lease(), taskRevision: task.parent.revisions,
          requestedArtifacts: plan.requestedArtifacts };
        const queued = h.environment.queuePendingAnswerRevision({
          lease: generationLease,
          suggestion: harnessModule.suggestion("visible-b", "Answer: The queue preserves FIFO order."),
          authorizedArtifacts: plan.requestedArtifacts, taskId: task.id, resultTaskId: task.id,
          sectionOwner: { kind: "parent-mainline", parentId: task.parent.id }, taskRevision: task.parent.revisions,
          logicalQuestionUnitId: plan.logicalQuestionUnitId, logicalQuestionRevision: plan.logicalQuestionRevision,
          sessionId: plan.sessionId, runtimeEpoch: plan.runtimeEpoch,
          questionSourceHash: plan.sourceHash, settlementId: plan.settlementId,
          settlementSnapshot: { questionType: plan.questionType, relation: plan.relation },
          resetSections: false, reason: "delivery-lock-active", latestUsefulAnswerMutationAuthorized: false,
          taskRuntimeRevision: context.getTaskRuntimeState().revision,
        });
        assert.ok(queued);
        assert.equal(h.environment.tryCommitPendingAnswer(), "waiting");
        if (stale) h.refs.manualCorrectionRevisionRef.current++;
        h.unlock();
        const disposition = h.environment.tryCommitPendingAnswer();
        assert.equal(disposition, stale ? "stale" : "committed");
        assert.equal(h.uiState.latestSuggestion.meetingAnswer.sections.answer,
          stale ? "Existing visible answer." : "The queue preserves FIFO order.");
        assert.deepEqual(plain(context.getState()), before, "publication does not change Type, phase, task or source state");
        // Only wall-clock performance counters vary; ownership and all output fields compare exactly.
        const { commitDurationMs, prepareDurationMs, installDurationMs, ...ledger } =
          h.generationResultLedger.getEntry(generationLease.id);
        for (const duration of [commitDurationMs, prepareDurationMs, installDurationMs]) {
          assert.ok(duration === undefined || (Number.isFinite(duration) && duration >= 0));
        }
        assert.ok(observerCalls >= 2, "actual callbacks must reach the recorder observation boundary");
        const actual = plain({ plan, job: { prompt: job.promptContextSnapshot, authority: job.taskMutationAuthority,
          responseAuthority: job.responseAuthoritySource, mode: job.mode }, authorized, disposition,
          stable: h.refs.stableAnswerRevisionRef.current, ui: h.uiState, uiUpdates: h.uiUpdates,
          ledger, observerCalls, context: context.getState() });
        if (expected === undefined) expected = actual;
        else assert.deepEqual(actual, expected, `${mode}/stale=${stale}`);
        if (mode === "close-failed") {
          assert.deepEqual(plain(manager.getState()), retained);
          assert.equal(io.writes, writesBefore, "actual publication observer cannot reopen sealed recording");
        }
      } finally {
        h.restore();
        io.failTerminal = false;
        await manager.stop("fixture-cleanup");
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});
