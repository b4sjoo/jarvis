import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  ApplicationShutdownCoordinator, connectApplicationShutdownOwner,
  requestApplicationShutdown, SHUTDOWN_REQUEST_EVENT,
  type ApplicationShutdownOwner, type ApplicationShutdownReceipt,
  type ShutdownRequest, type ShutdownStepReceipt, type ShutdownTransport,
} from "../src/lib/app-shutdown.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let index = 0; index < 20; index++) await Promise.resolve(); }

// Two WebViews share only IPC/events, never an imported JS coordinator singleton.
// Native waiting/exit checks are independently tested in app_shutdown/gate.rs.
function nativeEventStub() {
  const mainListeners = new Set<(event: { payload: unknown }) => void>();
  let receipt: ApplicationShutdownReceipt | null = null;
  let exits = 0;
  let requests = 0;
  const reports: ShutdownStepReceipt[] = [];
  function dispatch() {
    const request = { generation: receipt!.generation, attempt: receipt!.attempt };
    for (const listener of mainListeners) listener({ payload: request });
  }
  function transport(label: "main" | "dashboard"): ShutdownTransport {
    return {
      async listen<T>(event: string, handler: (event: { payload: T }) => void) {
        assert.equal(label, "main");
        assert.equal(event, SHUTDOWN_REQUEST_EVENT);
        const listener = handler as (event: { payload: unknown }) => void;
        mainListeners.add(listener);
        return () => { mainListeners.delete(listener); };
      },
      async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
        if (command === "exit_app") {
          requests++;
          if (!receipt) {
            receipt = { generation: 1, attempt: 1, waiting: true, forced: false,
              origin: label, elapsedMs: 0, results: [], unresolvedRecordingFolder: null };
            dispatch();
          }
          return undefined as T;
        }
        if (command === "get_app_shutdown") return (receipt && { ...receipt }) as T;
        assert.ok(receipt);
        assert.equal(args?.generation, receipt.generation);
        if (command === "retry_app_shutdown") {
          assert.equal(receipt.waiting, false);
          assert.equal(args?.attempt, receipt.attempt);
          receipt.attempt++;
          receipt.waiting = true;
          dispatch();
          return undefined as T;
        }
        if (command === "force_app_shutdown") {
          assert.equal(receipt.waiting, false);
          receipt.forced = true;
          exits++;
          return undefined as T;
        }
        assert.equal(label, "main", "only main may settle or complete");
        if (args?.attempt !== receipt.attempt || !receipt.waiting) return false as T;
        if (command === "report_app_shutdown") {
          const step = args.receipt as ShutdownStepReceipt;
          reports.push(step);
          receipt.results = [...receipt.results.filter((r) => r.stage !== step.stage), step];
          receipt.unresolvedRecordingFolder = args.unresolvedRecordingFolder as string | null;
          if (step.result === "failed-retryable") receipt.waiting = false;
          return true as T;
        }
        assert.equal(command, "complete_app_shutdown");
        exits++;
        return undefined as T;
      },
    };
  }
  return {
    main: transport("main"), dashboard: transport("dashboard"), reports,
    get receipt() { return receipt!; }, get exits() { return exits; },
    get requests() { return requests; }, get listeners() { return mainListeners.size; },
    timeout() { receipt!.waiting = false; receipt!.elapsedMs = 8000; },
    retry() { return this.dashboard.invoke("retry_app_shutdown", {
      generation: receipt!.generation, attempt: receipt!.attempt,
    }); },
    force() { return this.dashboard.invoke("force_app_shutdown", {
      generation: receipt!.generation, attempt: receipt!.attempt,
    }); },
  };
}

function owner(overrides: Partial<ApplicationShutdownOwner> = {}): ApplicationShutdownOwner {
  return {
    freezeNewWork: async () => "settled",
    drainRuntimeAndCapture: async () => "skipped",
    finalizeRecordingAndTraces: async () => "skipped",
    unresolvedRecordingFolder: () => null,
    ...overrides,
  };
}
async function mount(native: ReturnType<typeof nativeEventStub>, callbacks = owner()) {
  const coordinator = new ApplicationShutdownCoordinator(callbacks, native.main);
  const errors: unknown[] = [];
  const disconnect = await connectApplicationShutdownOwner(coordinator, native.main, (e) => errors.push(e));
  return { coordinator, errors, disconnect };
}

test("Dashboard actual Quit helper reaches only the mounted main owner; duplicate Quit coalesces", async () => {
  const native = nativeEventStub();
  let stops = 0;
  const { errors, disconnect } = await mount(native, owner({
    drainRuntimeAndCapture: async () => { stops++; return "settled"; },
  }));
  await requestApplicationShutdown(native.dashboard);
  await requestApplicationShutdown(native.dashboard);
  await flush();
  assert.equal(native.requests, 2);
  assert.equal(stops, 1);
  assert.equal(native.exits, 1);
  assert.deepEqual(errors, []);
  disconnect();
  assert.equal(native.listeners, 0);
});

test("Quit before main listener registration is recovered by listen-then-query", async () => {
  const native = nativeEventStub();
  await requestApplicationShutdown(native.dashboard);
  assert.equal(native.exits, 0);
  await mount(native);
  await flush();
  assert.equal(native.exits, 1);
});

test("native Stop reply alone cannot seal; frontend terminal acceptance and STT drain precede recording", async () => {
  const native = nativeEventStub();
  const stopReply = deferred();
  const terminal = deferred();
  const stt = deferred();
  const order: string[] = [];
  await mount(native, owner({
    freezeNewWork: async () => { order.push("freeze"); return "settled"; },
    drainRuntimeAndCapture: async () => {
      order.push("native-stop"); await stopReply.promise;
      order.push("native-reply"); await terminal.promise;
      order.push("terminal-enqueued"); await stt.promise;
      order.push("stt-drained"); return "settled";
    },
    finalizeRecordingAndTraces: async () => { order.push("127-seal"); return "settled"; },
  }));
  await requestApplicationShutdown(native.dashboard);
  await flush();
  stopReply.resolve(); await flush();
  assert.deepEqual(order, ["freeze", "native-stop", "native-reply"]);
  assert.equal(native.exits, 0);
  terminal.resolve(); await flush();
  assert.equal(order.includes("127-seal"), false);
  stt.resolve(); await flush();
  assert.deepEqual(order, ["freeze", "native-stop", "native-reply", "terminal-enqueued", "stt-drained", "127-seal"]);
  assert.equal(native.exits, 1);
});

test("failed recorder Retry uses same folder and does not repeat successful native drain", async () => {
  const native = nativeEventStub();
  let stops = 0;
  let closes = 0;
  let sealed = false;
  await mount(native, owner({
    drainRuntimeAndCapture: async () => { stops++; return "settled"; },
    finalizeRecordingAndTraces: async () => {
      closes++; if (closes === 1) throw new Error("write failed");
      sealed = true; return "settled";
    },
    unresolvedRecordingFolder: () => sealed ? null : "folder-127-generation-A",
  }));
  await requestApplicationShutdown(native.dashboard); await flush();
  assert.equal(native.exits, 0);
  assert.equal(native.receipt.waiting, false);
  assert.equal(native.receipt.unresolvedRecordingFolder, "folder-127-generation-A");
  await requestApplicationShutdown(native.dashboard); await flush();
  assert.equal(closes, 1, "repeated Quit is not Retry");
  await native.retry(); await flush();
  assert.equal(stops, 1);
  assert.equal(closes, 2);
  assert.equal(native.exits, 1);
});

test("timeout then Retry while drain is pending shares owner Promise; old attempt cannot advance", async () => {
  const native = nativeEventStub();
  const drain = deferred();
  let stops = 0;
  let seals = 0;
  await mount(native, owner({
    drainRuntimeAndCapture: async () => { stops++; await drain.promise; return "settled"; },
    finalizeRecordingAndTraces: async () => { seals++; return "settled"; },
  }));
  await requestApplicationShutdown(native.dashboard); await flush();
  native.timeout();
  await native.retry(); await flush();
  assert.equal(stops, 1);
  drain.resolve(); await flush();
  assert.equal(stops, 1);
  assert.equal(seals, 1);
  assert.equal(native.exits, 1);
});

test("late drain after timeout cannot seal or exit until user Retry", async () => {
  const native = nativeEventStub();
  const drain = deferred();
  let seals = 0;
  await mount(native, owner({
    drainRuntimeAndCapture: async () => { await drain.promise; return "settled"; },
    finalizeRecordingAndTraces: async () => { seals++; return "settled"; },
  }));
  await requestApplicationShutdown(native.dashboard); await flush();
  native.timeout(); drain.resolve(); await flush();
  assert.equal(seals, 0);
  assert.equal(native.exits, 0);
  await native.retry(); await flush();
  assert.equal(seals, 1);
  assert.equal(native.exits, 1);
});

test("late seal completion remains stopped; retry consumes success without resealing", async () => {
  const native = nativeEventStub();
  const seal = deferred();
  let closes = 0;
  await mount(native, owner({
    finalizeRecordingAndTraces: async () => { closes++; await seal.promise; return "settled"; },
  }));
  await requestApplicationShutdown(native.dashboard); await flush();
  native.timeout(); seal.resolve(); await flush();
  assert.equal(native.exits, 0);
  await native.retry(); await flush();
  assert.equal(closes, 1);
  assert.equal(native.exits, 1);
});

test("failure and timeout stay unresolved, Force is a separate explicit command", async () => {
  const native = nativeEventStub();
  await mount(native, owner({ drainRuntimeAndCapture: async () => { throw new Error("native failure"); } }));
  await requestApplicationShutdown(native.dashboard); await flush();
  assert.equal(native.exits, 0);
  const results = [...native.receipt.results];
  await native.force();
  assert.equal(native.exits, 1);
  assert.equal(native.receipt.forced, true);
  assert.deepEqual(native.receipt.results, results);
  const absentMain = nativeEventStub();
  await requestApplicationShutdown(absentMain.dashboard);
  absentMain.timeout();
  assert.equal(absentMain.exits, 0);
  await absentMain.force();
  assert.equal(absentMain.exits, 1);
});

test("untyped legacy Stop resolution is failure, never a forged terminal result", async () => {
  const native = nativeEventStub();
  await mount(native, owner({
    drainRuntimeAndCapture: (async () => undefined) as unknown as ApplicationShutdownOwner["drainRuntimeAndCapture"],
  }));
  await requestApplicationShutdown(native.dashboard); await flush();
  assert.equal(native.exits, 0);
  assert.equal(native.reports[native.reports.length - 1]?.result, "failed-retryable");
});

test("listener cleanup on initial snapshot failure and stale attempt dedupe", async () => {
  const native = nativeEventStub();
  const { coordinator } = await mount(native);
  await requestApplicationShutdown(native.dashboard); await flush();
  const request: ShutdownRequest = { generation: 1, attempt: 1 };
  assert.equal(coordinator.accept(request), coordinator.accept(request));
  await coordinator.accept({ generation: 1, attempt: 0 });
  assert.equal(native.exits, 1);
  await assert.rejects(coordinator.accept({ generation: 2, attempt: 1 }));
  let cleaned = false;
  await assert.rejects(connectApplicationShutdownOwner(coordinator, {
    listen: async () => () => { cleaned = true; },
    invoke: async () => { throw new Error("IPC disconnected"); },
  }, () => undefined));
  assert.equal(cleaned, true);
});

test("production entry delegates native; Dashboard dialog does not import main owner", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  const menu = read("src/hooks/useMenuItems.tsx");
  const shortcuts = read("src-tauri/src/shortcuts.rs");
  const native = read("src-tauri/src/app_shutdown.rs");
  assert.match(menu, /requestApplicationShutdown\(\{ invoke \}\)/);
  assert.match(shortcuts, /crate::app_shutdown::request\(&app_handle, "dashboard"\)/);
  assert.doesNotMatch(shortcuts, /app_handle\.exit\(/);
  assert.match(native, /RunEvent::ExitRequested/);
  assert.match(native, /api\.prevent_exit\(\)/);
  assert.match(native, /emit_to\(\s*"main",\s*REQUEST_EVENT/);
  const registration = read("src-tauri/src/lib.rs");
  assert.match(registration, /mod app_shutdown;/);
  assert.match(registration, /manage\(app_shutdown::AppShutdownState::default\(\)\)/);
  for (const command of ["get_app_shutdown", "retry_app_shutdown", "report_app_shutdown", "complete_app_shutdown", "force_app_shutdown"]) {
    assert.ok(registration.includes(`app_shutdown::${command},`));
  }
  assert.match(registration, /\.build\(tauri::generate_context!\(\)\)[\s\S]*?\.run\(app_shutdown::on_run_event\)/);
  assert.match(read("src/layouts/DashboardLayout.tsx"), /<ApplicationShutdownDialog/);
  assert.doesNotMatch(read("src/components/ApplicationShutdownDialog.tsx"), /useMeetingAssistant|ApplicationShutdownCoordinator/);
  assert.match(read("src/hooks/useApplicationShutdown.ts"), /getCurrentWindow\(\)\.label !== "main"/);
  const windows = read("src-tauri/src/window.rs");
  assert.match(windows, /CloseRequested[\s\S]*?prevent_close\(\)[\s\S]*?hide\(\)/);
});
