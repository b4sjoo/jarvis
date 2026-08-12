import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const binary = (path: string) => readFileSync(resolve(process.cwd(), path));

const readPngHeader = (path: string) => {
  const contents = binary(path);
  assert.deepEqual(
    [...contents.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10]
  );
  return {
    width: contents.readUInt32BE(16),
    height: contents.readUInt32BE(20),
    colorType: contents[25],
  };
};

test("desktop icon assets derive from one square RGBA identity", () => {
  const expected = new Map([
    ["src-tauri/icons/32x32.png", 32],
    ["src-tauri/icons/128x128.png", 128],
    ["src-tauri/icons/128x128@2x.png", 256],
    ["src-tauri/icons/icon.png", 512],
    ["src-tauri/icons/moss-icon-source.png", 1_254],
  ]);

  for (const [path, size] of expected) {
    const header = readPngHeader(path);
    assert.deepEqual(header, { width: size, height: size, colorType: 6 });
  }

  assert.equal(binary("src-tauri/icons/icon.icns").subarray(0, 4).toString(), "icns");
  assert.deepEqual(
    [...binary("src-tauri/icons/icon.ico").subarray(0, 4)],
    [0, 0, 1, 0]
  );
});

test("Tauri bundles only generated desktop icon variants", () => {
  const config = JSON.parse(
    binary("src-tauri/tauri.conf.json").toString("utf8")
  );
  assert.deepEqual(config.bundle.icon, [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.icns",
    "icons/icon.ico",
  ]);
});

test("macOS development restores the signed-off icon after leaving stealth mode", () => {
  const nativeShell = binary("src-tauri/src/lib.rs").toString("utf8");
  assert.match(nativeShell, /fn restore_development_application_icon/);
  assert.match(nativeShell, /include_bytes!\("\.\.\/icons\/icon\.icns"\)/);
  assert.match(
    nativeShell,
    /if !enabled \{\s*restore_development_application_icon\(&app\)\?/s
  );
});

test("the application shell and companion use the signed-off MOSS identity", () => {
  const appShell = binary("src/pages/app/index.tsx").toString("utf8");
  const companion = binary("src/pages/calling/index.tsx").toString("utf8");

  for (const source of [appShell, companion]) {
    assert.match(source, /src-tauri\/icons\/icon\.png/);
    assert.match(source, /<img src=\{mossLogo\} alt="" aria-hidden="true"/);
  }
  assert.doesNotMatch(appShell, /className="app-mark"><Headphones/);
  assert.doesNotMatch(companion, /className="brand-mark"><Headphones/);
});
