import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import test from "node:test";

let instance = 0;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function harness() {
  const loaded = deferred<object>();
  const bootstrapped = deferred<void>();
  const materialInitialized = deferred<void>();
  const calls: string[] = [];
  const row = {
    workspace_id: "w", material_id: "m", extension: "pdf", revision_id: "r", revision: 1,
    source_checksum_sha256: "source", extraction_status: "ready", extraction_request_id: "request",
    extraction_started_at: 1, completed_at: 2, extracted_text_relative_path: null,
    extraction_metadata: null, output_hash: null, review_status: "approved", review_actor: "user",
    review_updated_at: 2, review_event_id: null, quality_signals_json: "[]", derived_from_revision_id: null,
  };
  const database = {
    async select() { calls.push("select"); return [row]; },
    async execute() { throw new Error("A reader attempted a database write"); },
  };
  const key = `__task164Readiness${++instance}`;
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  globals[key] = {
    load(name: string) { assert.equal(name, "sqlite:jarvis.db"); calls.push("load"); return loaded.promise; },
    invoke(name: string) {
      if (name === "preparation_extraction_initialize") { calls.push("material-initialize"); return materialInitialized.promise; }
      assert.equal(name, "memory_content_initialize"); calls.push("bootstrap"); return bootstrapped.promise;
    },
  };
  const moduleUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
  const sqlUrl = moduleUrl(`export default { load: (...args) => globalThis.${key}.load(...args) };`);
  const coreUrl = moduleUrl(`export const invoke = (...args) => globalThis.${key}.invoke(...args);`);
  const configUrl = moduleUrl(stripTypeScriptTypes(readFileSync("src/lib/database/config.ts", "utf8")) + `\n// ${key}`);
  const repositoryUrl = moduleUrl(stripTypeScriptTypes(readFileSync("src/lib/database/preparation-extraction.action.ts", "utf8")) + `\n// ${key}`);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      const url = specifier === "@tauri-apps/plugin-sql" ? sqlUrl
        : specifier === "@tauri-apps/api/core" ? coreUrl
          : specifier === "./config" && context.parentURL === repositoryUrl ? configUrl : undefined;
      return url ? { url, shortCircuit: true } : next(specifier, context);
    },
  });
  const config = await import(configUrl) as { getDatabase(): Promise<typeof database> };
  const { preparationMaterialExtractionRepository: repository } = await import(repositoryUrl) as {
    preparationMaterialExtractionRepository: {
      getCurrent(id: string): Promise<{ outputHash?: string }>;
      getSelected(id: string): Promise<{ outputHash?: string }>;
      getRevision(id: string, revision: string): Promise<{ outputHash?: string }>;
    };
  };
  return { loaded, materialInitialized, bootstrapped, database, calls, config, repository,
    dispose() { hooks.deregister(); delete globals[key]; } };
}

test("database readiness shares one promise and gates every extraction reader behind bootstrap", async () => {
  const h = await harness();
  try {
    const first = h.config.getDatabase();
    assert.equal(h.config.getDatabase(), first);
    const reads = [h.repository.getCurrent("m"), h.repository.getSelected("m"), h.repository.getRevision("m", "old")];
    assert.deepEqual(h.calls, ["load"]);
    h.loaded.resolve(h.database);
    await Promise.resolve();
    assert.deepEqual(h.calls, ["load", "material-initialize"]);
    h.materialInitialized.resolve();
    await Promise.resolve();
    assert.deepEqual(h.calls, ["load", "material-initialize", "bootstrap"]);
    let ready = false;
    void first.then(() => { ready = true; });
    await Promise.resolve();
    assert.equal(ready, false);
    h.bootstrapped.resolve();
    assert.equal(await first, h.database);
    assert.ok((await Promise.all(reads)).every((row) => row.outputHash === undefined));
    for (let i = 0; i < 5; i++) {
      await h.repository.getRevision("m", "old");
      await h.repository.getSelected("m");
    }
    assert.equal(h.config.getDatabase(), first);
    assert.equal(h.calls.filter((call) => call === "load").length, 1);
    assert.equal(h.calls.filter((call) => call === "bootstrap").length, 1);
    assert.equal(h.calls.filter((call) => call === "select").length, 13);
  } finally { h.dispose(); }
});

test("bootstrap failure rejects all waiting readers without publishing database readiness", async () => {
  const h = await harness();
  try {
    const ready = h.config.getDatabase();
    const outcomes = Promise.allSettled([ready, h.repository.getCurrent("m"), h.repository.getSelected("m")]);
    h.loaded.resolve(h.database);
    await Promise.resolve();
    h.materialInitialized.resolve();
    await Promise.resolve();
    h.bootstrapped.reject(new Error("bootstrap transaction rolled back"));
    for (const outcome of await outcomes) {
      assert.equal(outcome.status, "rejected");
      if (outcome.status === "rejected") assert.match(String(outcome.reason), /bootstrap transaction rolled back/);
    }
    assert.deepEqual(h.calls, ["load", "material-initialize", "bootstrap"]);
  } finally { h.dispose(); }
});

test("database load failure never starts native bootstrap", async () => {
  const h = await harness();
  try {
    const ready = h.config.getDatabase();
    const rejected = assert.rejects(ready, /database unavailable/);
    h.loaded.reject(new Error("database unavailable"));
    await rejected;
    assert.deepEqual(h.calls, ["load"]);
  } finally { h.dispose(); }
});
