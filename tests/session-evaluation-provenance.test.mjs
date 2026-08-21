import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseSessionEvaluationProvenanceArgs,
  setSessionEvaluationProvenance,
} from "../scripts/set-session-evaluation-provenance.mjs";

test("requires one session and exactly one provenance action", () => {
  assert.deepEqual(
    parseSessionEvaluationProvenanceArgs([
      "--session",
      "session-example",
      "--scripted",
    ]),
    { session: "session-example", scriptedValidation: true }
  );
  assert.throws(
    () => parseSessionEvaluationProvenanceArgs(["--session", "session-example"]),
    /exactly one/
  );
  assert.throws(
    () =>
      parseSessionEvaluationProvenanceArgs([
        "--session",
        "session-example",
        "--scripted",
        "--organic",
      ]),
    /exactly one/
  );
});

test("marks and clears scripted validation without mutating the sealed manifest", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "jarvis-session-provenance-")
  );
  try {
    await mkdir(path.join(directory, "evaluation"), { recursive: true });
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = '{\n  "sessionId": "session_recording_1",\n  "status": "stopped"\n}\n';
    await writeFile(manifestPath, manifest, "utf8");

    const scripted = await setSessionEvaluationProvenance({
      sessionDirectory: directory,
      scriptedValidation: true,
      now: 100,
    });
    const duplicate = await setSessionEvaluationProvenance({
      sessionDirectory: directory,
      scriptedValidation: true,
      now: 101,
    });
    const organic = await setSessionEvaluationProvenance({
      sessionDirectory: directory,
      scriptedValidation: false,
      now: 102,
    });

    assert.equal(scripted.changed, true);
    assert.equal(duplicate.changed, false);
    assert.equal(organic.changed, true);
    assert.equal(await readFile(manifestPath, "utf8"), manifest);
    const effective = JSON.parse(
      await readFile(
        path.join(directory, "evaluation", "session-provenance.json"),
        "utf8"
      )
    );
    assert.equal(effective.effectiveScriptedValidation, false);
    const history = (
      await readFile(
        path.join(
          directory,
          "evaluation",
          "session-provenance-history.jsonl"
        ),
        "utf8"
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      history.map((entry) => entry.action),
      ["mark-scripted", "mark-organic"]
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
