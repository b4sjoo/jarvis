import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Execute whole production hooks/components, with deterministic React scheduling
// and native I/O replaced at module imports. No callback bodies are reimplemented.
export class PreparationHookHost {
  private slots: any[] = [];
  private cursor = 0;
  private effects: (() => void)[] = [];
  dirty = true;
  output: any;
  renders = 0;
  constructor(private renderBody: () => any) {}
  render() {
    this.cursor = 0;
    this.dirty = false;
    currentHost = this;
    this.output = this.renderBody();
    currentHost = undefined;
    this.renders++;
    const effects = this.effects.splice(0);
    effects.forEach((effect) => effect());
  }
  unmount() {
    this.slots.forEach((slot) => slot.cleanup?.());
    this.dirty = false;
  }
  state(initial: any) {
    const index = this.cursor++;
    this.slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
    const slot = this.slots[index];
    slot.set ??= (value: any) => {
      const next = typeof value === "function" ? value(slot.value) : value;
      if (!Object.is(next, slot.value)) { slot.value = next; this.dirty = true; }
    };
    return [slot.value, slot.set];
  }
  memo(create: () => any, deps?: any[]) {
    const index = this.cursor++;
    const slot = this.slots[index];
    if (!slot || !equalDeps(slot.deps, deps)) this.slots[index] = { value: create(), deps };
    return this.slots[index].value;
  }
  effect(create: () => any, deps?: any[]) {
    const index = this.cursor++;
    const slot = this.slots[index];
    if (slot && equalDeps(slot.deps, deps)) return;
    this.effects.push(() => {
      slot?.cleanup?.();
      this.slots[index] = { deps, cleanup: create() };
    });
  }
  external(subscribe: (listener: () => void) => () => void, snapshot: () => any) {
    this.effect(() => subscribe(() => { this.dirty = true; }), [subscribe]);
    return snapshot();
  }
}
let currentHost: PreparationHookHost | undefined;
const equalDeps = (a?: any[], b?: any[]) => Boolean(a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));
const react = {
  useState: (initial: any) => currentHost!.state(initial),
  useRef: (initial: any) => currentHost!.memo(() => ({ current: initial }), []),
  useMemo: (create: () => any, deps: any[]) => currentHost!.memo(create, deps),
  useCallback: (callback: any, deps: any[]) => currentHost!.memo(() => callback, deps),
  useEffect: (create: () => any, deps: any[]) => currentHost!.effect(create, deps),
  useLayoutEffect: (create: () => any, deps: any[]) => currentHost!.effect(create, deps),
  useSyncExternalStore: (subscribe: any, snapshot: any) => currentHost!.external(subscribe, snapshot),
};
export function loadPreparationModules(preparation: any, timers: Map<number, { callback: () => void; delay: number }>) {
  const cache = new Map<string, any>();
  let timerId = 0;
  const jsx = (type: any, props: any) => ({ type, props });
  const namedComponents = new Proxy({}, { get: (_target, name) => String(name) });
  function load(name: string): any {
    if (cache.has(name)) return cache.get(name);
    const filename = `src/pages/interview-preparation/${name}`;
    const code = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const exports = {};
    const context = vm.createContext({
      exports, console, AbortController, Date, Promise, Set, Map, Error,
      window: {
        setInterval(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
        clearInterval(id: number) { timers.delete(id); },
      },
      require(module: string) {
        if (module === "react") return react;
        if (module === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
        if (module === "@/components" || module === "lucide-react") return namedComponents;
        if (module === "@/contexts") return { useApp: () => ({ allAiProviders: [], selectedPreparationAIProvider: { provider: "fixture" } }) };
        if (module.includes("page-resource")) return load("page-resource.ts");
        if (module.includes("usePreparationData")) return load("usePreparationData.ts");
        if (module.includes("snapshot-selection-events")) return { subscribeToPreparationSnapshotSelectionChanges: preparation.subscribe };
        if (module.includes("preparation")) return preparation;
        if (module === "@tauri-apps/api/core") return { invoke: async () => undefined };
        if (module === "@tauri-apps/plugin-dialog") return { open: async () => undefined };
        throw new Error(`Unexpected production import: ${module}`);
      },
    });
    vm.runInContext(code, context, { filename });
    cache.set(name, exports);
    return exports;
  }
  return load;
}

export function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function elements(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...elements(tree.props?.children)];
}

export async function settle(hosts: PreparationHookHost[], afterRender?: () => void) {
  for (let i = 0; i < 80; i++) {
    for (const host of hosts) {
      if (host.dirty) { host.render(); afterRender?.(); }
    }
    await Promise.resolve();
  }
  if (hosts.some((host) => host.dirty)) throw new Error("Hook did not converge");
}
