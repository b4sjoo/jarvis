import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("SR168 CLI versions missingness and leaves original evidence and old report intact", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-sr168-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const compiled = path.join(root, "compiled"), session = path.join(root, "session"), output = path.join(root, "v3");
  for (const dir of [compiled, path.join(session, "taxonomy"), path.join(session, "traces"), path.join(session, "human-evaluation"), path.join(session, "evaluation", "semantic-taxonomy")]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(path.join(compiled, "package.json"), JSON.stringify({ type: "module" }));
  const build = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.semantic-taxonomy-reflection.json", "--outDir", compiled], { encoding: "utf8" });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const source = [true, false, undefined].map((value, index) => JSON.stringify({ recordedAt: index,
    sessionId: "s", traceId: `trace-${index}`, metadata: { taxonomySemanticParentMutationBlocked: value } })).join("\n") + "\n";
  const originals = new Map([
    ["manifest.json", JSON.stringify({ sessionId: "s", status: "closed", startedAt: 1, endedAt: 2 })],
    ["taxonomy/semantic-decisions.jsonl", source],
    ["human-evaluation/ground-truth-v2.jsonl", JSON.stringify({ schemaVersion: 2, eventId: "truth", sessionId: "s",
      subject: { attemptId: "trace-0", questionId: "q-0", traceIds: ["trace-0"], sourceTurnIds: [] },
      fact: { kind: "expected-task-settlement", expectedQuestionType: "coding", expectedRelation: "new-parent", expectedParentAction: "create" },
      provenance: { source: "explicit-ui", actor: "human", collection: "scripted-validation", sourceTraceId: "trace-0", recordedAt: 50 },
      confirmation: "confirmed" }) + "\n"],
    ["evaluation/semantic-taxonomy/reflection.json", JSON.stringify({ version: 2, metrics: { parentMutationBlocked: 1 } })],
  ]);
  for (const [file, data] of originals) await writeFile(path.join(session, file), data);
  const run = spawnSync(process.execPath, [path.join(compiled, "scripts/reflect-semantic-taxonomy-session.js"),
    "--session", session, "--output", output], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const report = JSON.parse(await readFile(path.join(output, "reflection.json"), "utf8"));
  const markdown = await readFile(path.join(output, "reflection.md"), "utf8");
  const provenance = JSON.parse(await readFile(path.join(output, "provenance.json"), "utf8"));
  assert.equal(report.version, 3);
  assert.deepEqual([report.metrics.parentMutationBlocked, report.metrics.parentMutationBlockedKnown, report.metrics.parentMutationBlockedMissing], [1, 2, 1]);
  assert.equal(Object.hasOwn(report.rows[2], "parentMutationBlocked"), false);
  assert.match(markdown, /Version: 3/);
  assert.match(markdown, /recorded 2\/3; missing 1/);
  assert.equal(provenance.producerVersion, `semantic-taxonomy-reflection/v${report.version}`);
  for (const [file, data] of originals) assert.equal(await readFile(path.join(session, file), "utf8"), data, file);
});
