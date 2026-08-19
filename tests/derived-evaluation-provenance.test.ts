import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DERIVED_EVALUATION_HISTORY_PATH,
  writeDerivedEvaluationProvenance,
} from "../scripts/lib/derived-evaluation-provenance.js";

test("records derived evaluation provenance without mutating the sealed manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jarvis-derived-eval-"));
  const sessionDirectory = path.join(root, "session-a");
  const outputDirectory = path.join(
    sessionDirectory,
    "evaluation",
    "semantic-taxonomy"
  );
  await mkdir(sessionDirectory, { recursive: true });
  const manifest = {
    sessionId: "session-a-id",
    status: "stopped",
    endedAt: 1_000,
    closedAt: 1_100,
    integrity: { failedWrites: 0 },
  };
  const manifestPath = path.join(sessionDirectory, "manifest.json");
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, manifestText, "utf8");

  try {
    const result = await writeDerivedEvaluationProvenance({
      producer: "test-reflector",
      command: "test:reflect",
      sessionDirectories: [sessionDirectory],
      outputDirectory,
      outputPaths: ["reflection.json", "reflection.md"],
      generatedAt: 2_000,
      producerVersion: "0.1.9",
    });

    assert.equal(result.sourceSessions[0]?.sessionId, "session-a-id");
    assert.equal(result.sourceSessions[0]?.recordingSealedAt, 1_100);
    assert.equal(result.generatedAt, 2_000);
    assert.equal(result.producerVersion, "0.1.9");
    assert.equal(await readFile(manifestPath, "utf8"), manifestText);

    const persisted = JSON.parse(
      await readFile(path.join(outputDirectory, "provenance.json"), "utf8")
    ) as typeof result;
    assert.equal(persisted.command, "test:reflect");
    assert.deepEqual(persisted.outputPaths, [
      path.join(outputDirectory, "reflection.json"),
      path.join(outputDirectory, "reflection.md"),
    ]);

    const history = (
      await readFile(
        path.join(sessionDirectory, DERIVED_EVALUATION_HISTORY_PATH),
        "utf8"
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as typeof result);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.runId, result.runId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
