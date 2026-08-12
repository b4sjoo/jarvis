import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MOSS_DEV_PORT,
  buildTauriArgs,
  resolveMossDevPort,
} from "../scripts/lib/moss-dev-port.mjs";

test("MOSS development port defaults to 1420 and accepts an explicit override", () => {
  assert.equal(resolveMossDevPort({}), DEFAULT_MOSS_DEV_PORT);
  assert.equal(resolveMossDevPort({ MOSS_DEV_PORT: "1421" }), 1421);
  assert.throws(
    () => resolveMossDevPort({ MOSS_DEV_PORT: "not-a-port" }),
    /Invalid MOSS_DEV_PORT/
  );
  assert.throws(
    () => resolveMossDevPort({ MOSS_DEV_PORT: "65535" }),
    /Invalid MOSS_DEV_PORT/
  );
});

test("Tauri and Vite share the explicit MOSS development port", () => {
  assert.deepEqual(buildTauriArgs(["dev"], {}), ["dev"]);
  assert.deepEqual(buildTauriArgs(["build"], { MOSS_DEV_PORT: "1421" }), ["build"]);

  const args = buildTauriArgs(["dev", "--", "--release"], {
    MOSS_DEV_PORT: "1421",
  });
  assert.equal(args[0], "dev");
  assert.equal(args[1], "--config");
  assert.deepEqual(JSON.parse(args[2]), {
    build: { devUrl: "http://localhost:1421" },
  });
  assert.deepEqual(args.slice(3), ["--", "--release"]);
});
