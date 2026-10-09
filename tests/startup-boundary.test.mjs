import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("SI206: the sole owner is acquired before Tauri creates any product resources", () => {
  const source=fs.readFileSync('src-tauri/src/lib.rs','utf8');
  const run=source.slice(source.indexOf('pub fn run()'));
  assert.ok(run.indexOf('InstanceGuard::acquire')<run.indexOf('tauri::Builder::default()'));
  assert.match(run,/let _instance_guard = match acquired/);
  assert.match(run,/Ok\(None\) =>[\s\S]*?return;/);
  assert.match(run,/if autostart::supported\(&app.config\(\).identifier\)/);
  for(const file of ['default','cross-platform']) {
    const permissions=JSON.parse(fs.readFileSync(`src-tauri/capabilities/${file}.json`)).permissions;
    assert.equal(permissions.some(p=>p.startsWith('autostart:')),false);
  }
  const context=fs.readFileSync('src/contexts/app.context.tsx','utf8');
  assert.doesNotMatch(context, /plugin-autostart|AUTOSTART_INITIALIZED/);
  assert.match(context,/"get_autostart_status"/);
  assert.match(context,/"set_autostart_enabled"/);
  const pkg=JSON.parse(fs.readFileSync('package.json'));
  const lock=JSON.parse(fs.readFileSync('package-lock.json'));
  assert.equal(pkg.dependencies['@tauri-apps/plugin-autostart'],undefined);
  assert.equal(lock.packages['node_modules/@tauri-apps/plugin-autostart'],undefined);
});
