import { defineConfig, mergeConfig, type Plugin } from "vite";
import path from "node:path";
import base from "../../vite.config";

// Explicit alternate config, never loaded by dev/build/test defaults.
export default defineConfig(async (env) => {
  const id = process.env.JARVIS_NATIVE_SMOKE_BUILD_ID;
  if (!id) throw new Error("An explicit native smoke build ID is required");
  const normal = await (base as (env: unknown) => Promise<object>)(env);
  const identityPlugin: Plugin = {
    name: "native-smoke-identity",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "native-smoke-build-id.txt", source: id });
    },
  };
  return mergeConfig(normal, {
    define: { __NATIVE_SMOKE_BUILD_ID__: JSON.stringify(id) },
    build: { rollupOptions: { input: {
      app: path.resolve("index.html"),
      smoke: path.resolve("tests/native-smoke/status.html"),
    } } },
    plugins: [identityPlugin],
  });
});
