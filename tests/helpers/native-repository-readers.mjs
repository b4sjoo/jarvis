import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// Invoked by the two native tests after production writers commit a temporary
// file database. The E1 failure stage additionally bridges claim/fail to that
// same native test binary and substitutes a real failing filesystem write.
const path = process.env.JARVIS_NATIVE_REPOSITORY_DB;
const expected = JSON.parse(process.env.JARVIS_NATIVE_REPOSITORY_EXPECTED ?? "null");
assert.ok(path && expected, "Run the native_repository_readers Cargo tests to create the fixture");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const db = new DatabaseSync(path, { readOnly: true });
const queries = [];
globalThis.__nativeRepositoryDatabase = {
  async select(sql, values = []) {
    queries.push(sql);
    return db.prepare(sql).all(...values);
  },
  async execute() { throw new Error("A production reader attempted a write"); },
};
const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const configUrl = dataUrl("export const getDatabase = async () => globalThis.__nativeRepositoryDatabase;");
const operations = [];
globalThis.__nativeExtractionInvoke = async (operation, { input }) => {
  assert.equal(expected.stage, "file-failure");
  assert.ok(["preparation_extraction_claim", "preparation_extraction_fail"].includes(operation));
  operations.push(operation);
  const resultPath = resolve(dirname(path), `${operation}.json`);
  const child = spawnSync(process.env.JARVIS_NATIVE_TEST_BINARY, ["--ignored", "--exact",
    "db::preparation_extraction::review_tests::task164_two_operation_driver"], {
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, JARVIS_NATIVE_OPERATION: operation, JARVIS_NATIVE_OPERATION_INPUT: JSON.stringify(input),
      JARVIS_NATIVE_OPERATION_RESULT: resultPath },
  });
  assert.equal(child.status, 0, `${child.error ?? ""}\n${child.stdout}\n${child.stderr}`);
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  if ("Err" in result) throw new Error(result.Err);
  assert.ok("Ok" in result);
  return result.Ok;
};
const coreUrl = dataUrl("export const invoke = (...args) => globalThis.__nativeExtractionInvoke(...args);");
const draftsUrl = dataUrl("export const CURATED_MEMORY_DRAFTS = [];");
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@tauri-apps/api/core") return { url: coreUrl, shortCircuit: true };
    let target;
    if (specifier.startsWith("@/")) target = resolve(root, "src", specifier.slice(2));
    else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      target = resolve(dirname(fileURLToPath(context.parentURL)), specifier);
    }
    if (!target) return next(specifier, context);
    const source = [target, target.replace(/\.js$/, ".ts"), `${target}.ts`, resolve(target, "index.ts")]
      .find((candidate) => candidate.endsWith(".ts") && existsSync(candidate));
    if (!source) return next(specifier, context);
    const url = source === resolve(root, "src/lib/database/config.ts") ? configUrl
      : source === resolve(root, "src/lib/memory/curated-drafts.ts") ? draftsUrl
        : pathToFileURL(source).href;
    return { url, shortCircuit: true };
  },
  load(url, context, next) {
    if (url.startsWith("file:") && url.endsWith(".ts")) {
      return {
        format: "module", shortCircuit: true,
        source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText,
      };
    }
    return next(url, context);
  },
});
const production = (path) => import(pathToFileURL(resolve(root, "src/lib", path)).href);

test(`native writer -> production repositories/services: ${expected.kind}/${expected.stage}`, async () => {
  try {
    const { preparationSnapshotRepository: snapshots } = await production("database/preparation-snapshot.action.ts");
    const { preparationStatementRepository: statements } = await production("database/preparation-statement.action.ts");
    if (expected.kind === "extraction") {
      const { preparationMaterialExtractionRepository: extraction } = await production("database/preparation-extraction.action.ts");
      const { preparationMaterialContextRepository: context } = await production("database/preparation-context.action.ts");
      const { createPreparationMaterialExtractionService } = await production("preparation/material-extraction-service.ts");
      if (expected.stage === "file-failure") {
        const originalPath = resolve(dirname(path), "materials/m/original.pdf");
        const original = readFileSync(originalPath);
        const blockedOutput = resolve(dirname(path), "blocked-output.txt");
        mkdirSync(blockedOutput);
        const ids = ["file-request", "file-b"];
        const failingService = createPreparationMaterialExtractionService({
          repository: extraction, createId: () => ids.shift(), now: () => 10,
          gateway: { async extract(input) {
            assert.equal(input.requestId, "file-request");
            assert.equal(input.revision, 2);
            writeFileSync(blockedOutput, "candidate B text");
          } },
        });
        await assert.rejects(failingService.schedule("w", "m", { force: true }), { code: "EISDIR" });
        assert.deepEqual(operations, ["preparation_extraction_claim", "preparation_extraction_fail"]);
        assert.deepEqual(readFileSync(originalPath), original);
        assert.deepEqual(await extraction.listChunks("file-b"), []);
      }
      const selected = await extraction.getSelected("m");
      assert.equal(selected.revisionId, expected.selected);
      assert.equal(selected.outputHash, expected.selectedHash);
      const retrieved = await context.searchCandidates({ processId: "w", roundId: "round", queryTokens: ["text"], preferredMaterialIds: [], limit: 20 });
      assert.deepEqual(retrieved.map((chunk) => [chunk.materialRevisionId, chunk.content]), [[expected.selected, expected.text]]);
      const service = createPreparationMaterialExtractionService({ repository: extraction, gateway: {} });
      const inspection = await service.inspect("w", "m");
      assert.equal(inspection.candidate.revisionId, expected.candidate);
      assert.equal(inspection.candidate.status, expected.candidateStatus);
      const old = await extraction.getRevision("m", "a");
      assert.equal(old.outputHash, expected.oldHash);
      assert.equal(old.reviewStatus, "approved");
      const oldChunks = await extraction.listChunks(old.revisionId);
      assert.deepEqual(oldChunks.map((chunk) => [chunk.content, chunk.extractionRequestId]), [["old text", "old"]]);
      const snapshot = await snapshots.get("w", "snapshot");
      const pin = snapshot.sourceManifest.materials[0];
      const historical = await extraction.getRevision(pin.materialId, pin.materialRevisionId);
      assert.equal(historical.outputHash, pin.outputHash);
      assert.equal(historical.outputHash, expected.oldHash);
      assert.deepEqual((await extraction.listChunks(historical.revisionId)).map((chunk) => chunk.content), ["old text"]);
      assert.equal(snapshot.runtimeBrief.role, "old text");
      const statement = await statements.get("w", "statement");
      assert.equal(statement.status, "confirmed");
      assert.equal(statement.sources[0].preview, "old text");
      const statementRevision = await extraction.getRevision(statement.sources[0].materialId, statement.sources[0].materialRevisionId);
      assert.equal(statementRevision.outputHash, expected.oldHash);
      assert.equal(statement.sources[0].sourceId, oldChunks[0].id);
      assert.equal(await extraction.getRevision("m", "missing"), undefined);
    } else {
      assert.equal(expected.kind, "memory");
      const memory = await production("database/memory.action.ts");
      const { createPreparationSnapshotService } = await production("preparation/snapshot-service.ts");
      const entries = await memory.getMemoryEntries();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].content, expected.text);
      assert.equal(entries[0].contentRevision, expected.revision);
      assert.equal(entries[0].contentHash, expected.hash);
      assert.equal(entries[0].enabled, expected.enabled);
      assert.equal(entries[0].lastUsedAt, 77);
      assert.equal((await memory.getEnabledMemoryEntries()).length, expected.enabled ? 1 : 0);
      assert.equal((await memory.getMemorySources())[0].title, expected.sourceTitle);
      const snapshot = await snapshots.get("p", "s1");
      const pin = snapshot.sourceManifest.kmbEntries[0];
      const historical = await memory.getMemoryEntryRevision(pin.entryId, pin.entryRevision);
      assert.equal(historical.contentHash, pin.contentHash);
      assert.equal(historical.contentHash, expected.oldHash);
      assert.equal(historical.content, "A");
      assert.equal(historical.enabled, expected.enabled);
      const source = await memory.getMemorySourceRevision("source", historical.sourceRevisions.source);
      assert.equal(source.title, "Source A");
      assert.equal(snapshot.runtimeBrief.role, "A");
      const statement = await statements.get("p", "statement");
      assert.equal(statement.status, "confirmed");
      assert.equal(statement.sources[0].preview, "A");
      const statementRevision = await memory.getMemoryEntryRevision(statement.sources[0].sourceId, statement.sources[0].kmbEntryRevision);
      assert.equal(statementRevision.contentHash, expected.oldHash);
      assert.equal(statementRevision.content, "A");
      assert.equal(await memory.getMemoryEntryRevision("entry", 999), undefined);
      const service = createPreparationSnapshotService({ snapshots, getKmbEntries: memory.getMemoryEntries });
      assert.equal((await service.getCurrentSnapshot()).id, "s1");
      if (expected.active) assert.equal((await service.getCurrentSnapshotForRuntimePin()).id, "s1");
      else await assert.rejects(service.getCurrentSnapshotForRuntimePin(), /changed|disabled|unverified/);
    }
    assert.ok(queries.length >= 8, "Actual repository queries must reach SQLite");
  } finally {
    hooks.deregister();
    db.close();
    delete globalThis.__nativeRepositoryDatabase;
    delete globalThis.__nativeExtractionInvoke;
  }
});
