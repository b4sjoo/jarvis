import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

export const fixtureSttProvider = {
  id: "stub", responseContentPath: "text",
  curl: "curl -X POST 'https://stt.invalid/transcribe' -F 'file=@audio' -F 'model=fixture'",
};

export function createSttFixture() {
  const requests: Array<{ url: string; body: FormData | Blob | string; signal?: AbortSignal }> = [];
  const require = createRequire(path.resolve("package.json"));
  const globals = {
    Blob, FormData, URLSearchParams, Error,
    FileReader: class {
      result = "";
      onloadend?: () => void;
      readAsDataURL(blob: Blob) {
        void blob.arrayBuffer().then((buffer) => {
          this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
          this.onloadend?.();
        });
      }
    },
  };
  const load = (file: string, imports: Record<string, unknown>, extra = {}) => {
    const context = vm.createContext({ ...globals, ...extra, exports: {}, require: (id: string) => {
      assert.ok(Object.hasOwn(imports, id), `Unexpected import: ${id}`); return imports[id];
    } });
    vm.runInContext(ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText, context);
    return context.exports;
  };
  const common = load("src/lib/functions/common.function.ts", {});
  const stt = load("src/lib/functions/stt.function.ts", {
    "./common.function": common,
    "@bany/curl-to-json": require("@bany/curl-to-json"),
  }, { fetch: async (url: string, request: any) => {
    assert.equal(url, "https://stt.invalid/transcribe");
    requests.push({ url, ...request });
    return new Response('{"text":"fixture transcript"}');
  } });
  return { requests, fetchSTT: stt.fetchSTT };
}
