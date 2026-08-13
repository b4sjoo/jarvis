import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = (path) => readFileSync(resolve(process.cwd(), path), "utf8");

test("Task 13 keeps provider secrets in a native private vault without Keychain access", () => {
  const nativeStore = source("src-tauri/src/credential_store.rs");
  const cargo = source("src-tauri/Cargo.toml");
  const routes = source("src/lib/calling/model-routes.ts");
  const models = source("src/pages/models/index.tsx");

  assert.match(nativeStore, /const ALLOWED_KEYS: \[&str; 4\]/);
  assert.match(nativeStore, /provider-credentials\.json/);
  assert.match(nativeStore, /create_new\(true\)/);
  assert.match(nativeStore, /sync_all\(\)/);
  assert.match(nativeStore, /Permissions::from_mode\(0o600\)/);
  assert.match(nativeStore, /Mutex<\(\)>/);
  assert.doesNotMatch(nativeStore, /security_framework|get_generic_password|set_generic_password/);
  assert.doesNotMatch(cargo, /security-framework/);
  assert.match(routes, /local private vault/);
  assert.match(models, /MOSS's local private vault/);
  assert.doesNotMatch(routes, /system keychain/i);
  assert.doesNotMatch(models, /OS keychain/i);
});

test("Task 13 does not move provider secrets into frontend persistent settings", () => {
  const routes = source("src/lib/calling/model-routes.ts");
  assert.match(routes, /const browserSecrets = new Map<string, string>\(\)/);
  assert.doesNotMatch(routes, /localStorage\.setItem\([^\n]*secret/i);
  assert.doesNotMatch(routes, /JSON\.stringify\([^\n]*secret/i);
});
