import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readRecordedProjectionSnapshot, readRecordedTraceSummaries } from "../scripts/lib/session-aggregate-evidence.js";

test("OP6: unsealed readers use saved rows and latest journal revisions, not stale aggregates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-op6-"));
  try {
    for (const dir of ["traces/t1", "metrics", "human-evaluation"]) await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({ status: "running" }));
    await writeFile(path.join(root, "metrics/trace-summaries.latest.json"), JSON.stringify({ traces: [{ traceId: "stale" }] }));
    const row = { traceId: "t1", startedAt: 1, answer: "final", revision: 2 };
    await writeFile(path.join(root, "traces/t1/summary.json"), JSON.stringify(row));
    await writeFile(path.join(root, "human-evaluation/projections-v2.jsonl"), [{ projectionId: "p", value: 1 }, { projectionId: "p", value: 2 }].map((row) => JSON.stringify(row)).join("\n") + '\n{"projectionId":');
    assert.deepEqual((await readRecordedTraceSummaries(root)).traces, [row]);
    const projection = await readRecordedProjectionSnapshot(root);
    assert.deepEqual(projection.projections, [{ projectionId: "p", value: 2 }]);
    assert.equal(projection.history.length, 2);
    await writeFile(path.join(root, "traces/t1/summary.json"), '{"traceId":');
    const damaged = await readRecordedTraceSummaries(root);
    assert.deepEqual(damaged.traces, []);
    assert.equal(damaged.warnings.length, 1);
    assert.equal(JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")).status, "running");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("OP8: killed recording writer retains completed single-trace facts without final aggregates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-op8-"));
  const moduleUrl = new URL("../src/lib/meeting/session-recording.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { mkdir, writeFile, appendFile } from 'node:fs/promises';
    import path from 'node:path';
    const { SessionRecordingManager } = await import(process.env.RECORDER_MODULE);
    const root = process.env.RECORDER_ROOT;
    const invoke = async (command, args) => {
      if (command === 'start_meeting_session_recording') {
        await writeFile(path.join(root, 'manifest.json'), args.manifestPayload);
        return root;
      }
      const file = path.join(root, args.relativePath);
      await mkdir(path.dirname(file), { recursive: true });
      if (args.relativePath === 'traces/interrupted/summary.json') {
        await writeFile(file, '{"traceId":');
        process.send('interrupted');
        await new Promise(() => {});
      }
      if (command.endsWith('_text')) await (args.append ? appendFile : writeFile)(file, args.payload);
      else await writeFile(file, Buffer.from(args.base64 ?? '', 'base64'));
      return file;
    };
    const manager = new SessionRecordingManager(undefined, invoke);
    await manager.start({ meetingSessionId: 'crash-fixture', settings: { codingModel: { enabled:false,provider:'',variables:{} }, taxonomyAdjudication: { enabled:false,provider:'',variables:{} } }, providerSummary: {} });
    for (const id of ['saved', 'interrupted', 'queued']) manager.recordTrace({ id, kind:'voice', status:'success', startedAt:Date.now(), endedAt:Date.now(), durationMs:1, steps:[], inputs:[], outputs:[], metadata:{} }, 'manual');
    setInterval(() => {}, 1000);
  `], { env: { ...process.env, RECORDER_ROOT: root, RECORDER_MODULE: moduleUrl }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  try {
    const message = await Promise.race([once(child, "message"), once(child, "exit").then(([code]) => { throw new Error(`Fixture exited early: ${code}: ${stderr}`); })]);
    assert.equal(message[0], "interrupted");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const recovered = await readRecordedTraceSummaries<{ traceId: string }>(root);
    assert.deepEqual(recovered.traces.map((trace) => trace.traceId), ["saved"]);
    assert.ok(recovered.warnings.some((warning) => warning.includes("interrupted")));
    assert.notEqual(JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")).status, "stopped");
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await rm(root, { recursive: true, force: true }); }
});
