import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_JARVIS_DEV_PORT,
  buildTauriArgs,
  resolveJarvisDevPort,
} from "../scripts/lib/jarvis-dev-port.mjs";

test("uses the default Jarvis development port when no override is set", () => {
  assert.equal(resolveJarvisDevPort({}), DEFAULT_JARVIS_DEV_PORT);
  assert.equal(resolveJarvisDevPort({ JARVIS_DEV_PORT: "  " }), DEFAULT_JARVIS_DEV_PORT);
});

test("accepts a valid custom Jarvis development port", () => {
  assert.equal(resolveJarvisDevPort({ JARVIS_DEV_PORT: "1422" }), 1422);
});

test("rejects malformed and out-of-range development ports", () => {
  for (const value of ["abc", "0", "65535", "1420.5", "+1422"]) {
    assert.throws(
      () => resolveJarvisDevPort({ JARVIS_DEV_PORT: value }),
      /Invalid JARVIS_DEV_PORT/
    );
  }
});

test("adds a matching Tauri devUrl override only for the dev command", () => {
  const args = buildTauriArgs(["dev"], { JARVIS_DEV_PORT: "1422" });

  assert.deepEqual(args, [
    "dev",
    "--config",
    JSON.stringify({ build: { devUrl: "http://localhost:1422" } }),
  ]);
  assert.deepEqual(buildTauriArgs(["build"], { JARVIS_DEV_PORT: "1422" }), [
    "build",
  ]);
});

test("inserts the Tauri config before runner and application arguments", () => {
  const args = buildTauriArgs(["dev", "--", "--release"], {
    JARVIS_DEV_PORT: "1500",
  });

  assert.deepEqual(args, [
    "dev",
    "--config",
    JSON.stringify({ build: { devUrl: "http://localhost:1500" } }),
    "--",
    "--release",
  ]);
});
