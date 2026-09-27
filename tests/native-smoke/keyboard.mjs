import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { publishedApp, workspace } from "./build.mjs";

const execute = promisify(execFile);
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const stateFile = dir => path.join(dir, "keyboard.json");
const logFile = dir => path.join(dir, "stderr.log");
const callbackPrefix = "Shortcut triggered: ";

export function validateRun(manifest, lifecycle, directory) {
  if (manifest.status !== "built" || lifecycle.status !== "running" ||
      lifecycle.buildId !== manifest.id || lifecycle.directory !== directory ||
      lifecycle.appPath !== publishedApp || manifest.appPath !== publishedApp ||
      manifest.keyboardHelper !== path.join(workspace, "keyboard-helper") ||
      !Number.isInteger(lifecycle.pid) || lifecycle.pid <= 0) {
    throw new Error("Not an owned running smoke build");
  }
}

function loadRun(directory, expected) {
  const lifecycle = readJson(path.join(directory, "lifecycle.json"));
  const manifest = readJson(path.join(directory, "..", "build.json"));
  validateRun(manifest, lifecycle, directory);
  if (expected && (lifecycle.pid !== expected.pid || manifest.id !== expected.buildId)) {
    throw new Error("Keyboard observation belongs to another run");
  }
  return { manifest, lifecycle };
}

// Byte offsets preserve complete UTF-8 lines and never rescan earlier log history while waiting.
export function logSince(file, offset) {
  const size = fs.statSync(file).size;
  if (size < offset) throw new Error("Native log was truncated");
  const bytes = Buffer.alloc(size - offset);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, bytes, 0, bytes.length, offset); }
  finally { fs.closeSync(fd); }
  const complete = bytes.lastIndexOf(10) + 1;
  let cursor = offset;
  const lines = bytes.subarray(0, complete).toString("utf8").split("\n").slice(0, -1).map(line => {
    cursor += Buffer.byteLength(line + "\n");
    return { line, end: cursor };
  });
  return { lines, end: offset + complete };
}

function unchangedRun(directory, state) {
  const run = loadRun(directory, state);
  if (logSince(logFile(directory), state.bindingOffset).lines.some(({ line }) =>
    line.startsWith("Updating shortcuts with "))) {
    throw new Error("Shortcut registration changed after the observed snapshot");
  }
  return run;
}

function noUnrequestedCallbacks(directory, state) {
  const tail = logSince(logFile(directory), state.cursor);
  if (tail.lines.some(({ line }) => line.startsWith(callbackPrefix))) {
    throw new Error("Unexpected or duplicate native shortcut callback");
  }
  return tail.end;
}

export function prepareKeyboard(directory) {
  directory = path.resolve(directory);
  const { manifest, lifecycle } = loadRun(directory);
  const log = logSince(logFile(directory), 0);
  const observed = log.lines.findLast(({ line }) => line.startsWith("NativeSmokeObservation "));
  if (!observed) throw new Error("Open Read Smoke Status before preparing keyboard input");
  const snapshot = JSON.parse(observed.line.slice("NativeSmokeObservation ".length));
  if (snapshot.buildId !== manifest.id || snapshot.pid !== lifecycle.pid ||
      !snapshot.shortcutBindings || Array.isArray(snapshot.shortcutBindings)) {
    throw new Error("Missing or mismatched native binding snapshot");
  }
  const state = { buildId: manifest.id, pid: lifecycle.pid, bindings: snapshot.shortcutBindings,
    bindingOffset: observed.end, cursor: log.end, failed: false, finished: false, actions: [] };
  unchangedRun(directory, state);
  fs.writeFileSync(stateFile(directory), JSON.stringify(state, null, 2), { flag: "wx" });
  return state;
}

async function nativeSend(helper, args, timeout) {
  try {
    const { stdout } = await execute(helper, args, { timeout, maxBuffer: 64 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.stdout) {
      const result = JSON.parse(error.stdout);
      if (result.status === "blocked") return result;
    }
    throw error;
  }
}

async function withKeyboard(directory, operation) {
  const lock = path.join(directory, "keyboard.lock");
  const fd = fs.openSync(lock, "wx");
  let state;
  try {
    state = readJson(stateFile(directory));
    if (state.failed || state.finished) throw new Error("This keyboard run is stopped; do not retry it");
    return await operation(state);
  } catch (error) {
    if (state && !state.finished) {
      state.failed = true;
      state.error = String(error);
      const attempt = state.actions.at(-1);
      if (attempt?.status === "attempting") { attempt.status = "failed"; attempt.error = String(error); }
    }
    throw error;
  } finally {
    try { if (state) fs.writeFileSync(stateFile(directory), JSON.stringify(state, null, 2)); }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
}

export async function sendShortcut(directory, action, {
  sender = nativeSend, timeoutMs = 10000, now = () => performance.now(),
  wait = () => new Promise(resolve => setTimeout(resolve, 25)),
} = {}) {
  directory = path.resolve(directory);
  return withKeyboard(directory, async state => {
    const { manifest, lifecycle } = unchangedRun(directory, state);
    const startOffset = noUnrequestedCallbacks(directory, state);
    const binding = Object.hasOwn(state.bindings, action) ? state.bindings[action] : undefined;
    // The Swift policy owns the two supported action/key pairs; it rejects all other input.
    if (typeof binding !== "string") throw new Error("Action has no observed native binding");
    const started = now();
    const record = { action, binding, startOffset, startedAt: new Date().toISOString(), status: "attempting" };
    state.actions.push(record);
    fs.writeFileSync(stateFile(directory), JSON.stringify(state, null, 2));
    const sent = await sender(manifest.keyboardHelper, [String(lifecycle.pid), publishedApp, action, binding], timeoutMs);
    record.sender = sent;
    if (sent.status !== "posted-not-yet-observed" || sent.action !== action || sent.binding !== binding ||
        sent.pid !== lifecycle.pid || !sent.keyDownPosted || !sent.keyUpPosted ||
        !Number.isFinite(sent.modifierFlagsBefore) || sent.modifierFlagsBefore !== sent.modifierFlagsAfter) {
      throw new Error(sent.reason ?? "Incomplete or mismatched native key delivery");
    }
    let cursor = startOffset;
    while (now() - started < timeoutMs) {
      loadRun(directory, state);
      const tail = logSince(logFile(directory), cursor);
      cursor = tail.end;
      if (tail.lines.some(({ line }) => line.startsWith("Updating shortcuts with "))) {
        throw new Error("Shortcut registration changed while waiting for the receipt");
      }
      const callbacks = tail.lines.filter(({ line }) => line.startsWith(callbackPrefix));
      if (callbacks.length) {
        if (callbacks.length !== 1 || callbacks[0].line !== callbackPrefix + action) {
          throw new Error("Unexpected or duplicate native shortcut callback");
        }
        state.cursor = cursor;
        record.status = "native-received";
        record.receiptLine = callbacks[0].line;
        record.endOffset = cursor;
        record.elapsedMs = now() - started;
        return record; // The caller must still assert the actual UI consequence.
      }
      await wait();
    }
    throw new Error("Native shortcut receipt timed out; toggle was not retried");
  });
}

export async function finishKeyboard(directory) {
  directory = path.resolve(directory);
  return withKeyboard(directory, async state => {
    unchangedRun(directory, state);
    state.cursor = noUnrequestedCallbacks(directory, state);
    state.finished = true;
    return state;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory, action] = process.argv.slice(2);
  try {
    if (!directory) throw new Error("Expected prepare|send|finish RUN_DIRECTORY [ACTION]");
    const result = command === "prepare" ? prepareKeyboard(directory)
      : command === "send" && action ? await sendShortcut(directory, action)
      : command === "finish" ? await finishKeyboard(directory) : (() => { throw new Error("Unknown keyboard command"); })();
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
