// Task 178A shared test helper. It builds the REAL critical event stream, and
// on request a REAL SessionRecordingManager writing real files, for injection
// into the existing AST harness environments. It hand-fills no event: every
// event a test reads was emitted by production Hook code that the harness
// lifted and executed.
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RUNTIME_CRITICAL_EVENT_JOURNAL_PATH,
  RuntimeCriticalEventStream,
  parseRuntimeCriticalEventJournal,
  type RuntimeCriticalEventClock,
  type RuntimeCriticalEventDelivery,
  type RuntimeCriticalEventLimits,
  type RuntimeCriticalEventV1,
} from "../../src/lib/meeting/runtime-critical-event.js";
import type {
  SessionRecordingInvoke,
  SessionRecordingManager,
} from "../../src/lib/meeting/session-recording.js";

// The Hook-level production callbacks every producer goes through. A harness
// extracts them from the Hook source the same way it extracts its callbacks.
export const RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS = [
  "emitRuntimeCriticalEvent",
  "observeTaskRuntimeWriter",
  "emitCurrentQuestionSettlementAdopted",
  "emitLogicalQuestionUnitCommitted",
  "announceStagedGenerationCommit",
] as const;

// Macrotask stand-in with no real timer: a harness that asserts exact timer
// counts is not disturbed, and delivery only happens when the test runs it.
export class ManualRuntimeCriticalEventClock implements RuntimeCriticalEventClock {
  private nextHandle = 1;
  private readonly tasks = new Map<number, () => void>();
  scheduled = 0;

  constructor(private readonly readNow: () => number = () => Date.now()) {}

  now() {
    return this.readNow();
  }

  schedule(callback: () => void) {
    const handle = this.nextHandle++;
    this.tasks.set(handle, callback);
    this.scheduled += 1;
    return handle;
  }

  cancel(handle: unknown) {
    this.tasks.delete(handle as number);
  }

  pendingCount() {
    return this.tasks.size;
  }

  runNext() {
    const next = this.tasks.entries().next();
    if (next.done) return false;
    const [handle, callback] = next.value;
    this.tasks.delete(handle);
    callback();
    return true;
  }

  runAll(maxTicks = 10_000) {
    let ticks = 0;
    while (this.runNext()) {
      ticks += 1;
      if (ticks > maxTicks) throw new Error("critical event clock did not settle");
    }
    return ticks;
  }
}

export interface RuntimeCriticalEventHarnessOptions {
  // Bind the stream to this runtime session and attach a collecting observer.
  sessionId?: string;
  observe?: boolean;
  clock?: RuntimeCriticalEventClock;
  now?: () => number;
  limits?: Partial<RuntimeCriticalEventLimits>;
}

export function createRuntimeCriticalEventHarness(
  options: RuntimeCriticalEventHarnessOptions = {}
) {
  const manualClock = options.clock
    ? undefined
    : new ManualRuntimeCriticalEventClock(options.now);
  const clock = options.clock ?? manualClock!;
  const stream = new RuntimeCriticalEventStream({ clock, limits: options.limits });
  const deliveries: RuntimeCriticalEventDelivery[] = [];
  const ref = { current: stream };
  // The Hook-level refs the lifted callbacks read, as the Hook declares them.
  const hookRefs = {
    runtimeCriticalEventStreamRef: ref,
    runtimeCriticalEventMountRef: { current: 0 },
    manualActionCriticalOriginRef: {
      current: new Map<string, { runtimeSessionId: string; runtimeEpoch: number }>(),
    },
  };
  const harness = {
    stream,
    clock,
    manualClock,
    ref,
    hookRefs,
    deliveries,
    bind(sessionId: string) {
      stream.bind(sessionId);
      return harness;
    },
    // A plain collecting observer, registered through the production API.
    observe() {
      return stream.subscribe((delivery) => {
        deliveries.push(delivery);
      });
    },
    flush() {
      return manualClock?.runAll() ?? 0;
    },
    events(): RuntimeCriticalEventV1[] {
      harness.flush();
      return deliveries.flatMap((delivery) =>
        delivery.kind === "event" ? [delivery.event] : []
      );
    },
    facts(purpose?: "formal" | "observation") {
      return harness
        .events()
        .filter((event) => !purpose || event.purpose === purpose)
        .map((event) =>
          event.terminal
            ? `${event.fact}:${event.terminal.object}:${event.terminal.disposition}`
            : `${event.fact}:${event.stage}`
        );
    },
    // Puts the real stream and the real Hook callbacks into a harness
    // environment. evaluateCallback is the harness's own extractor.
    install(
      environment: Record<string, unknown>,
      evaluateCallback: (name: string) => unknown
    ) {
      Object.assign(environment, hookRefs);
      for (const name of RUNTIME_CRITICAL_EVENT_HOOK_CALLBACKS) {
        environment[name] = evaluateCallback(name);
      }
      return harness;
    },
  };
  if (options.sessionId) {
    stream.bind(options.sessionId);
    if (options.observe !== false) harness.observe();
  }
  return harness;
}

export type RuntimeCriticalEventHarness = ReturnType<
  typeof createRuntimeCriticalEventHarness
>;

// Ids are allocated per run. A comparison across runs replaces each distinct
// identifier by its order of first appearance and keeps values that are
// business results (types, relations, stages, dispositions, revisions).
const IDENTIFIER_REFERENCES = new Set([
  "traceId",
  "operationId",
  "requestId",
  "attemptId",
  "executionPlanId",
  "turnId",
  "logicalQuestionUnitId",
  "settlementId",
  "receiptId",
  "taskId",
  "generationLeaseId",
  "advisorJobId",
  "suggestionId",
  "generationId",
  "manualActionId",
  "scenarioRunId",
  "scenarioStepId",
  "sourceTurnIds",
  "sourceObservationIds",
]);

export function normalizeRuntimeCriticalEvents(
  events: readonly RuntimeCriticalEventV1[],
  options: { purpose?: "formal" | "observation"; keepSequence?: boolean } = {}
) {
  const aliases = new Map<string, string>();
  const alias = (kind: string, value: string) => {
    const key = `${kind}|${value}`;
    let assigned = aliases.get(key);
    if (!assigned) {
      const index = [...aliases.keys()].filter((candidate) =>
        candidate.startsWith(`${kind}|`)
      ).length;
      assigned = `${kind}#${index + 1}`;
      aliases.set(key, assigned);
    }
    return assigned;
  };
  return events
    .filter((event) => !options.purpose || event.purpose === options.purpose)
    .map((event) => {
      const refs: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(event.refs)) {
        if (!IDENTIFIER_REFERENCES.has(key)) {
          refs[key] = value;
        } else if (Array.isArray(value)) {
          refs[key] = value.map((entry) => alias(key, String(entry)));
        } else {
          refs[key] = alias(key, String(value));
        }
      }
      return {
        ...(options.keepSequence ? { sequence: event.sequence } : {}),
        fact: event.fact,
        stage: event.stage,
        purpose: event.purpose,
        runtimeSessionId: alias("runtimeSessionId", event.runtimeSessionId),
        epochKnown: event.runtimeEpoch !== undefined,
        terminal: event.terminal
          ? {
              object: event.terminal.object,
              disposition: event.terminal.disposition,
              reason: event.terminal.reason,
            }
          : undefined,
        refs,
        omittedRefs: event.omittedRefs ? [...event.omittedRefs] : undefined,
      };
    });
}

// Recursively checks that an event holds only frozen plain data.
export function describeRuntimeCriticalEventShape(event: unknown) {
  const problems: string[] = [];
  const visit = (value: unknown, where: string) => {
    if (value === null || typeof value !== "object") {
      if (typeof value === "function") problems.push(`${where}: function`);
      return;
    }
    if (!Object.isFrozen(value)) problems.push(`${where}: not frozen`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== Array.prototype) {
      problems.push(`${where}: not plain data`);
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${where}.${key}`);
  };
  visit(event, "event");
  return problems;
}

export type RuntimeCriticalFactWaitResult =
  | { status: "matched"; event: RuntimeCriticalEventV1 }
  | { status: "ended"; event: RuntimeCriticalEventV1 }
  | { status: "closed"; reason: string; discarded: number }
  | { status: "incomplete"; reason: string }
  | { status: "rejected"; reason: string };

// A test-side observer, shaped like the consumer a later Replay executor would
// be. It lives under tests/ and is not a production executor. It decides
// nothing in the runtime: it only tells a test when a confirmed fact was
// delivered, so the test can submit its next input through an original entry.
// It uses no timer, no polling and no log or Trace read, and it always ends
// with an explicit status: the fact, a terminal that rules the fact out, the
// subscription closing (with the number of facts it was not handed), or
// evidence that is known to be incomplete.
export function awaitRuntimeCriticalFact(
  stream: RuntimeCriticalEventStream,
  options: {
    matches: (event: RuntimeCriticalEventV1) => boolean;
    endsOn?: (event: RuntimeCriticalEventV1) => boolean;
  }
) {
  let settle!: (result: RuntimeCriticalFactWaitResult) => void;
  const promise = new Promise<RuntimeCriticalFactWaitResult>((resolve) => {
    settle = resolve;
  });
  let done = false;
  let unsubscribe = () => {};
  const finish = (result: RuntimeCriticalFactWaitResult) => {
    if (done) return;
    done = true;
    unsubscribe();
    settle(result);
  };
  const subscription = stream.subscribe((delivery) => {
    if (delivery.kind === "closed") {
      finish({ status: "closed", reason: delivery.reason, discarded: delivery.discarded });
    } else if (delivery.kind === "gap") {
      finish({ status: "incomplete", reason: delivery.reason });
    } else if (options.matches(delivery.event)) {
      finish({ status: "matched", event: delivery.event });
    } else if (options.endsOn?.(delivery.event)) {
      finish({ status: "ended", event: delivery.event });
    }
  });
  unsubscribe = () => subscription.unsubscribe();
  if (!subscription.accepted) {
    finish({ status: "rejected", reason: subscription.reason ?? "not-accepting" });
  }
  return { promise, settled: () => done };
}

export interface RecordedWrite {
  command: string;
  relativePath: string;
  bytes: number;
  append: boolean;
}

// Real files under a temporary directory behind the manager's own injected
// native boundary. Nothing here knows about critical events.
export class TemporaryRecordingFiles {
  readonly writes: RecordedWrite[] = [];
  readonly folders: string[] = [];
  startCalls = 0;
  failWrite?: (relativePath: string) => boolean;
  blockWrite?: (relativePath: string) => Promise<void> | undefined;

  constructor(readonly root: string) {}

  invoke: SessionRecordingInvoke = async <T>(
    command: string,
    args: Record<string, unknown> = {}
  ) => {
    const folderName = String(args.folderName);
    const folder = path.join(this.root, folderName);
    if (command === "start_meeting_session_recording") {
      this.startCalls += 1;
      this.folders.push(folderName);
      await this.write(folder, command, "manifest.json", String(args.manifestPayload), false);
      await this.write(folder, command, "README.md", String(args.readmePayload), false);
      return folder as T;
    }
    if (
      command !== "write_meeting_session_recording_text" &&
      command !== "write_meeting_session_recording_base64"
    ) {
      return undefined as T;
    }
    const relativePath = String(args.relativePath);
    const blocked = this.blockWrite?.(relativePath);
    if (blocked) await blocked;
    if (this.failWrite?.(relativePath)) {
      throw new Error(`controlled write failure: ${relativePath}`);
    }
    const payload =
      command === "write_meeting_session_recording_base64"
        ? Buffer.from(String(args.base64Payload), "base64")
        : String(args.payload);
    await this.write(folder, command, relativePath, payload, args.append === true);
    return undefined as T;
  };

  private async write(
    folder: string,
    command: string,
    relativePath: string,
    payload: string | Buffer,
    append: boolean
  ) {
    const file = path.join(folder, relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    if (append) await appendFile(file, payload);
    else await writeFile(file, payload);
    this.writes.push({
      command,
      relativePath,
      bytes: Buffer.byteLength(payload),
      append,
    });
  }

  async readText(folderName: string, relativePath: string) {
    try {
      return await readFile(path.join(this.root, folderName, relativePath), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  // The production reader over the file the production writer produced.
  async readCriticalEventJournal(folderName: string) {
    return parseRuntimeCriticalEventJournal(
      await this.readText(folderName, RUNTIME_CRITICAL_EVENT_JOURNAL_PATH)
    );
  }

  async readManifest(folderName: string) {
    const text = await this.readText(folderName, "manifest.json");
    return text ? (JSON.parse(text) as Record<string, any>) : undefined;
  }

  criticalEventWrites() {
    return this.writes.filter(
      (write) => write.relativePath === RUNTIME_CRITICAL_EVENT_JOURNAL_PATH
    );
  }
}

const RECORDING_START_OPTIONS = {
  settings: {
    codingModel: { enabled: false, provider: "", variables: {} },
    taxonomyAdjudication: { enabled: true, provider: "", variables: {} },
  },
  providerSummary: {
    hasMainProvider: false,
    hasCodingProvider: false,
    hasTaxonomyAdjudicationProvider: false,
    hasSttProvider: false,
    mainSupportsImages: false,
    codingSupportsImages: false,
  },
};

// A real SessionRecordingManager over real temporary files.
export async function createFileBackedRecorder(prefix = "jarvis-critical-events-") {
  // A computed specifier keeps the recorder out of in-memory harness bundles
  // that only need the stream.
  const recorderModule = "../../src/lib/meeting/session-recording.js";
  const { SessionRecordingManager: Manager } = (await import(recorderModule)) as {
    SessionRecordingManager: typeof SessionRecordingManager;
  };
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const files = new TemporaryRecordingFiles(root);
  const manager: SessionRecordingManager = new Manager(undefined, files.invoke);
  return {
    manager,
    files,
    root,
    async start(meetingSessionId: string) {
      return manager.start({
        meetingSessionId,
        ...RECORDING_START_OPTIONS,
      } as unknown as Parameters<SessionRecordingManager["start"]>[0]);
    },
    stop(reason = "test-stop") {
      return manager.stop(reason);
    },
    async cleanup() {
      // Let an unfinished recording drain before its directory is removed, so
      // a failing test reports its own assertion and not a busy directory.
      try {
        await manager.stop("test-cleanup");
      } catch {
        // A controlled close failure is the test's own subject.
      }
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    },
  };
}

export type FileBackedRecorder = Awaited<ReturnType<typeof createFileBackedRecorder>>;
