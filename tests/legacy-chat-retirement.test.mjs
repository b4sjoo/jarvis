import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = process.cwd();
const ts = createRequire(path.join(root, "package.json"))("typescript");
const hookSource = readFileSync(
  process.env.JARVIS_USE_APP_TEST_SOURCE ?? path.join(root, "src/hooks/useApp.ts"),
  "utf8"
);
const databaseSource = readFileSync(
  path.join(root, "src/lib/database/chat-history.action.ts"),
  "utf8"
);

function loadModule(source, dependencies, globals = {}) {
  const exports = {};
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(javascript, {
    exports,
    console,
    ...globals,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  });
  return exports;
}

for (const blob of [null, "", "{broken", "[]", '[{"id":"legacy","title":"Old chat","messages":[]}]']) {
  for (const marker of [null, "false", "true"]) {
    test(`startup leaves legacy blob=${JSON.stringify(blob)} marker=${marker} untouched`, async () => {
      const storage = new Map();
      if (blob !== null) storage.set("chat_history", blob);
      if (marker !== null) storage.set("chat_history_migrated_to_sqlite", marker);
      const original = [...storage];
      const effects = [];
      const events = [];
      const storageCalls = [];
      const invocations = [];
      const listeners = new Map();
      let migrations = 0;
      let titles = 0;
      const systemAudio = {};
      const config = { screenshot: "CommandOrControl+Shift+S" };
      const safeLocalStorage = {
        getItem(key) { storageCalls.push(["get", key]); return storage.get(key) ?? null; },
        setItem(key, value) { storageCalls.push(["set", key]); storage.set(key, value); },
        removeItem(key) { storageCalls.push(["remove", key]); storage.delete(key); },
      };
      const api = loadModule(hookSource, {
        react: { useEffect: (fn) => effects.push(fn), useState: (value) => [value, () => {}] },
        "@/hooks": { useTitles: () => { titles++; }, useSystemAudio: () => systemAudio },
        "@tauri-apps/api/event": { listen: async () => () => {} },
        "@/lib": { safeLocalStorage, migrateLocalStorageToSQLite: async () => { migrations++; return { success: true, migratedCount: 0 }; } },
        "@/lib/storage": { getShortcutsConfig: () => config },
        "@tauri-apps/api/core": { invoke: async (...args) => { invocations.push(args); } },
      }, {
        window: {
          addEventListener: (name, fn) => listeners.set(name, fn),
          removeEventListener: (name) => listeners.delete(name),
          dispatchEvent: (event) => events.push(event),
        },
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
      });
      const app = api.useApp();
      const cleanup = effects.map((effect) => effect());
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(titles, 1);
      assert.equal(app.systemAudio, systemAudio);
      assert.equal(invocations.length, 1);
      assert.equal(invocations[0][0], "update_shortcuts");
      assert.equal(invocations[0][1].config, config);
      assert.deepEqual(storageCalls, []);
      assert.equal(migrations, 0);
      assert.deepEqual([...storage], original);
      app.handleSelectConversation({ id: "sqlite-conversation" });
      app.handleNewConversation();
      assert.equal(events[0].type, "conversationSelected");
      assert.equal(events[0].detail.id, "sqlite-conversation");
      assert.equal(events[1].type, "newConversation");
      for (const fn of cleanup) fn?.();
      assert.equal(listeners.size, 0);
    });
  }
}

test("SQLite Chat APIs remain usable without importing a storage migration dependency", async () => {
  const calls = [];
  const database = {
    execute: async (sql, values) => { calls.push({ sql, values }); return { rowsAffected: 1 }; },
    select: async () => [],
  };
  const api = loadModule(databaseSource, { "./config": { getDatabase: async () => database } });
  assert.equal(api.migrateLocalStorageToSQLite, undefined);
  const conversation = {
    id: "current", title: "Current Chat", createdAt: 1, updatedAt: 2,
    messages: [{ id: "message", role: "user", content: "hello", timestamp: 1 }],
  };
  assert.equal(await api.createConversation(conversation), conversation);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /^INSERT INTO conversations/);
  assert.equal(calls[0].values[0], "current");
  assert.match(calls[1].sql, /^INSERT INTO messages/);
  assert.equal((await api.getAllConversations()).length, 0);
  assert.equal(api.generateConversationTitle(" hello "), "hello");
  for (const name of ["getConversationById", "deleteConversation", "deleteAllConversations"]) {
    assert.equal(typeof api[name], "function", name);
  }
});
