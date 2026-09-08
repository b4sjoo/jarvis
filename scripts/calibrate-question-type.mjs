import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, chmodSync, existsSync } from "node:fs";
import { dirname, resolve, relative, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const inputFile = join(root, "scripts/calibrate-question-type-inputs.json");
const deepFreeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
export const frozenInputs = deepFreeze(JSON.parse(readFileSync(inputFile, "utf8")));
const hash = value => createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const limits = [
  "Production Type request, prompt, strict parser, request construction, retry coordinator and response decoder run from source.",
  "Node fetch replaces the host HTTP binding. Per-cap operation definition is injected only at the Type request import.",
  "No Hook scheduling, lease invalidation, settlement, Relation, RO, Advisor, recording or visible-output composition is exercised.",
  "Eight curated synthetic expectations are offline labels, not original Human Evaluation or general precision/recall evidence.",
  "Native diagnostics remain unavailable when the production decoder/provider does not supply them. No inferred token counts or p95.",
];

// This loader follows the source-execution tests, but retains complete modules and their dependencies.
// It is a tool-local composition adapter, never a replacement request/retry implementation.
export function createProductionRuntime({ cap, fetchImpl = () => { throw new Error("network disabled"); }, now = Date.now, onTerminal = () => {} } = {}) {
  if (![512, 1024].includes(cap)) throw new Error("Only approved caps 512 and 1024 are allowed");
  const cache = new Map();
  const sources = {};
  const requests = [];
  const events = [];
  class Clock extends Date { static now() { return now(); } }
  const context = vm.createContext({ Date: Clock, Error, TypeError, DOMException, AbortController, AbortSignal,
    TextDecoder, TextEncoder, URL, Uint8Array, setTimeout, clearTimeout,
    fetch: (...args) => fetchImpl(...args), crypto: globalThis.crypto,
    console: { log() {}, warn() {}, error() {} } });
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    if (!filename.startsWith(join(root, "src") + "/")) throw new Error("Source outside production tree");
    const source = readFileSync(filename, "utf8");
    sources[relative(root, filename)] = hash(source);
    const module = { exports: {} };
    cache.set(filename, module);
    const localRequire = specifier => {
      if (specifier === "@tauri-apps/plugin-http") return { fetch: (...args) => fetchImpl(...args) };
      if (specifier === "@bany/curl-to-json") return require(specifier);
      let target = specifier.startsWith("@/") ? join(root, "src", specifier.slice(2))
        : specifier.startsWith(".") ? resolve(dirname(filename), specifier) : undefined;
      if (!target) throw new Error(`Unsupported production dependency: ${specifier}`);
      target = target.replace(/\.js$/, "");
      if (!target.endsWith(".ts")) target = existsSync(target + ".ts") ? target + ".ts" : join(target, "index.ts");
      const exports = load(target);
      if (filename.endsWith("question-type-adjudication-request.ts") && target.endsWith("runtime-inference.ts")) {
        return { ...exports, getRuntimeInferenceOperationDefinition: kind => {
          if (kind !== "question-type-adjudication") throw new Error("Only Type operations allowed");
          return { ...exports.getRuntimeInferenceOperationDefinition(kind), maxOutputTokens: cap };
        } };
      }
      if (filename.endsWith("question-type-adjudication-request.ts") && target.endsWith("ai-response.function.ts")) {
        return { ...exports, fetchAIResponseEvents: async function* (params) {
          for await (const event of exports.fetchAIResponseEvents(params)) {
            events.push(event);
            if (event.type === "terminal") onTerminal(event.outcome);
            yield event;
          }
        } };
      }
      return exports;
    };
    // Compile the complete unmodified module. A forwarding observer records request options;
    // every attempt still executes the original function body, including its original timers.
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const observeBinding = filename.endsWith("ai-response.function.ts") ? `
      const originalAttempt = fetchAIResponseAttemptEvents;
      fetchAIResponseAttemptEvents = function(params, identity) {
        __observeAttempt(params, identity);
        return originalAttempt(params, identity);
      };` : "";
    const observe = (params, identity) => requests.push({ ...identity, timeoutMs: params.requestOptions?.timeoutMs,
      maxOutputTokens: params.requestOptions?.maxOutputTokens, systemPromptHash: hash(params.systemPrompt),
      userMessageHash: hash(params.userMessage), providerId: params.provider?.id,
      modelId: params.selectedProvider.variables.model ?? params.selectedProvider.variables.MODEL,
      retryPolicy: params.requestOptions?.retryPolicy });
    vm.runInContext(`(function(require,module,exports,__observeAttempt){${code}\n${observeBinding}\n})`, context, { filename })(localRequire, module, module.exports, observe);
    return module.exports;
  }
  const type = load(join(root, "src/lib/meeting/question-type-adjudication.ts"));
  const requestModule = load(join(root, "src/lib/meeting/question-type-adjudication-request.ts"));
  function makeRequest(input) {
    // Labels and category never cross the model boundary; context is an existing bounded prior.
    const text = input.text;
    return type.buildQuestionTypeAdjudicationRequest({ logicalQuestionUnit: {
      id: "calibration-question", revision: 1, sessionId: "calibration", runtimeEpoch: 1,
      currentTurnId: "turn", sourceTurnIds: ["turn"], normalizedText: text,
      sources: [{ turnId: "turn", text, startedAt: 0, endedAt: 1 }], startedAt: 0, updatedAt: 1,
      compositionReasons: ["independent-current-turn"], boundaryReason: "independent-current-turn", truncated: false,
    }, ...(input.currentBranchType ? { structuredHints: { currentBranchType: input.currentBranchType } } : {}) });
  }
  return { sources, requests, events, makeRequest, prompts: type.buildQuestionTypeAdjudicationPrompts,
    builtinProvider: id => load(join(root, "src/config/ai-providers.constants.ts")).AI_PROVIDERS.find(p => p.id === id),
    parse: type.parseQuestionTypeAdjudicationOutput,
    async run({ config, request, operationId }) {
      const startedAt = now();
      const result = await requestModule.requestQuestionTypeAdjudication({ ...config, request,
        signal: new AbortController().signal, timeoutMs: 4000, readRetryDeadlineAt: () => startedAt + 4000,
        isExecutionCurrent: () => true, executionIdentity: { requestId: operationId, executionPlanId: operationId,
          sessionId: "bounded-calibration", runtimeEpoch: 1 } });
      return { ...result, startedAt, durationMs: now() - startedAt,
        onTimeStrictValid: Boolean(result.parsed.ok && result.completedAt <= startedAt + 4000) };
    } };
}

export function resolveBuiltinProviderConfig(selectedProvider) {
  const provider = createProductionRuntime({ cap: 512 }).builtinProvider(selectedProvider?.provider);
  if (!provider) throw new Error("Unknown builtin provider; supply explicit provider config");
  return validateConfig({ provider, selectedProvider });
}

function validateConfig(config) {
  if (config?.selectedProvider && !config.provider) return resolveBuiltinProviderConfig(config.selectedProvider);
  if (!config?.provider?.id || typeof config.provider.curl !== "string" ||
      config.selectedProvider?.provider !== config.provider.id || !config.selectedProvider?.variables ||
      Object.values(config.selectedProvider.variables).some(v => typeof v !== "string")) throw new Error("Expected {provider, selectedProvider:{provider, variables}} config");
  const curlModule = require("@bany/curl-to-json");
  const curl = (curlModule.default ?? curlModule)(config.provider.curl);
  const url = new URL(curl.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Use HTTPS without inline URL credentials");
  return deepFreeze(structuredClone({ provider: config.provider, selectedProvider: config.selectedProvider }));
}

export function redact(value, config) {
  const secrets = Object.entries(config.selectedProvider.variables).filter(([key]) => !["model", "model_id"].includes(key.toLowerCase())).map(([, v]) => v).filter(Boolean);
  // Also cover literal header values in locally saved custom cURL templates.
  const curlModule = require("@bany/curl-to-json");
  const curl = (curlModule.default ?? curlModule)(config.provider.curl);
  for (const [key, v] of Object.entries(curl.header ?? {})) {
    if (key.toLowerCase() !== "content-type" && typeof v === "string" && !v.includes("{{")) secrets.push(v, v.replace(/^Bearer\s+/i, ""));
  }
  const url = new URL(curl.url);
  for (const value of url.searchParams.values()) if (value && !value.includes("{{")) secrets.push(value);
  const collectBodyCredentials = (value, key = "") => {
    if (typeof value === "string" && /key|token|secret|password|credential|authorization/i.test(key) && !value.includes("{{")) secrets.push(value);
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) collectBodyCredentials(v, k);
  };
  collectBodyCredentials(curl.data);
  const clean = item => {
    if (typeof item === "string") {
      for (const secret of secrets.sort((a, b) => b.length - a.length)) {
        for (const form of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) item = item.split(form).join("[REDACTED]");
      }
      return item;
    }
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([k, v]) => [clean(k), clean(v)]));
    return item;
  };
  return clean(value);
}

export function createPlan(rawConfig) {
  const config = validateConfig(rawConfig);
  const runtime = createProductionRuntime({ cap: 512 });
  const inputs = frozenInputs.map(input => {
    const request = runtime.makeRequest(input);
    const prompts = runtime.prompts(request);
    return { ...input, request, prompts, inputHash: hash(request), promptHash: hash(prompts) };
  });
  if (inputs.length !== 8 || new Set(inputs.map(i => i.id)).size !== 8 ||
      ["opening-design", "concept-followup", "coding", "contextual-followup"].some(c => inputs.filter(i => i.category === c).length !== 2)) throw new Error("Approved eight-input manifest changed");
  const operations = [];
  for (const input of inputs) for (let repetition = 0; repetition < 3; repetition++) {
    const pair = operations.length / 2;
    for (const cap of pair % 2 ? [1024, 512] : [512, 1024]) operations.push({ id: `pair-${pair}-cap-${cap}`, inputId: input.id, repetition, pair, cap });
  }
  // Do not persist arbitrary provider metadata or cURL templates (which can embed credentials).
  const safeConfig = redact(config, config);
  const publicConfig = { providerId: config.provider.id, streaming: config.provider.streaming,
    responseContentPath: config.provider.responseContentPath,
    model: config.selectedProvider.variables.model ?? config.selectedProvider.variables.MODEL ?? null,
    variableNames: Object.keys(config.selectedProvider.variables).sort(),
    requestConfigurationHash: hash(safeConfig) };
  const plan = { schemaVersion: 1, deadlineMs: 4000, maxOperations: 48, maxAttempts: 96, maxAttemptsPerOperation: 2,
    config: publicConfig, configHash: hash(publicConfig), inputsHash: hash(frozenInputs), inputs, operations,
    productionSourceHashes: runtime.sources, toolHash: hash(readFileSync(fileURLToPath(import.meta.url), "utf8")),
    executionEnvironment: { node: process.version, typescript: ts.version,
      curlParserSourceHash: hash(readFileSync(require.resolve("@bany/curl-to-json"), "utf8")) },
    evidenceLimits: limits, expectationProvenance: "curated-synthetic-offline-only" };
  return deepFreeze({ ...plan, experimentHash: hash(plan),
    protocolClaimHash: hash({ protocol: "bounded-type-1A-v1", configHash: plan.configHash, inputsHash: plan.inputsHash }) });
}

export function summarize(rows) {
  const byCap = {};
  for (const cap of [512, 1024]) {
    const group = rows.filter(r => r.cap === cap);
    const durations = group.map(r => r.durationMs).sort((a, b) => a - b);
    const count = predicate => group.filter(predicate).length;
    const successful = count(r => r.onTimeStrictValid);
    const outputDenominator = count(r => r.strictValidOutput);
    const correct = count(r => r.strictValidOutput && r.semanticCorrect);
    const retried = count(r => r.attempts.length > 1);
    const recovered = count(r => r.attempts.length > 1 && r.onTimeStrictValid);
    byCap[cap] = { operations: group.length, actualAttempts: group.reduce((n, r) => n + r.attempts.length, 0),
      firstAttemptStrictValid: count(r => r.attempts[0]?.strictValid), onTimeStrictValid: successful,
      firstAttemptStrictValidRate: group.length ? count(r => r.attempts[0]?.strictValid) / group.length : null,
      onTimeStrictValidRate: group.length ? successful / group.length : null,
      retriedOperations: retried,
      retryEligibleFailuresObserved: count(r => r.attempts[0]?.outcome?.disposition === "retrying"),
      eligibleFailureRecovery: recovered, recoveryAmongRetriedRate: retried ? recovered / retried : null,
      successfulOutputDenominator: outputDenominator, semanticCorrectAllLabeled: correct,
      onTimeSemanticCorrect: count(r => r.onTimeStrictValid && r.semanticCorrect),
      successfulOutputAccuracy: outputDenominator ? correct / outputDenominator : null,
      correctAmongAllLabeled: group.length ? correct / group.length : null,
      nativeFinishReasonAvailable: group.flatMap(r => r.attempts).filter(a => a.outcome?.nativeFinishReason !== undefined).length,
      nativeUsageAvailable: group.flatMap(r => r.attempts).filter(a => a.outcome?.tokenUsage !== undefined).length,
      durationMs: durations.length ? { min: durations[0], max: durations.at(-1), median: (durations[Math.floor((durations.length - 1) / 2)] + durations[Math.floor(durations.length / 2)]) / 2 } : null,
      perInput: group.map(r => ({ inputId: r.inputId, operationId: r.id, onTimeStrictValid: r.onTimeStrictValid,
        semanticCorrect: r.semanticCorrect, predicted: r.predicted, durationMs: r.durationMs })) };
  }
  return { actualOperations: rows.length, actualAttempts: rows.reduce((n, r) => n + r.attempts.length, 0), byCap, evidenceLimits: limits };
}

export async function runExperiment({ config: rawConfig, outputDir, ledgerDir = join(root, ".local/question-type-calibration-claims"), mode = "dry-run", fetchImpl, approvedHash }) {
  if (!["dry-run", "fixture", "live"].includes(mode)) throw new Error("Invalid mode");
  if (mode === "live" && fetchImpl) throw new Error("Live mode uses only standard fetch");
  if (mode === "fixture" && !fetchImpl) throw new Error("Fixture mode requires controlled fetch");
  const config = validateConfig(rawConfig);
  const plan = createPlan(config);
  if (mode === "live" && approvedHash !== plan.experimentHash) throw new Error("Reviewed manifest hash required");
  let actualCalls = 0;
  let operationCalls = 0;
  let activeOp;
  let journalFailed = false;
  const journal = record => {
    try { appendFileSync(join(outputDir, "attempts.jsonl"), JSON.stringify(redact(record, config)) + "\n"); }
    catch { journalFailed = true; throw new Error("Journal write failed; stop calibration"); }
  };
  const boundedFetch = async (url, init) => {
    if (mode === "dry-run" || journalFailed || actualCalls >= 96 || operationCalls >= 2) throw new Error("Call prohibited by frozen experiment guard");
    actualCalls++; operationCalls++;
    journal({ event: "http-start", operationId: activeOp.id, callNumber: actualCalls, attemptNumber: operationCalls,
      at: Date.now(), method: init.method, url, body: JSON.parse(init.body), headerNames: Object.keys(init.headers) });
    return (mode === "live" ? globalThis.fetch : fetchImpl)(url, init);
  };
  const runtimes = new Map([512, 1024].map(cap => [cap, createProductionRuntime({ cap, fetchImpl: boundedFetch,
    onTerminal: outcome => journal({ event: "terminal", operationId: activeOp.id, outcome }) })]));
  for (const runtime of runtimes.values()) if (hash(runtime.sources) !== hash(plan.productionSourceHashes)) throw new Error("Production source changed while freezing plan");
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const write = (file, data) => writeFileSync(join(outputDir, file), JSON.stringify(redact(data, config), null, 2) + "\n", { flag: "wx", mode: 0o600 });
  write("manifest.json", { ...plan, mode, frozenAt: new Date().toISOString() });
  chmodSync(join(outputDir, "manifest.json"), 0o400);
  if (mode === "dry-run") return { mode, experimentHash: plan.experimentHash, plannedOperations: 48, maxAttempts: 96 };
  mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
  // Permanent exclusive claim: failed/interrupted runs are not resumable or success-seeking reruns.
  writeFileSync(join(ledgerDir, `${mode}-${plan.protocolClaimHash}.json`), JSON.stringify({ experimentHash: plan.experimentHash, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  for (const file of ["operations.jsonl", "attempts.jsonl"]) writeFileSync(join(outputDir, file), "", { flag: "wx", mode: 0o600 });
  const rows = [];
  let stopReason;
  for (const op of plan.operations) {
    activeOp = op;
    operationCalls = 0;
    const runtime = runtimes.get(op.cap);
    const input = plan.inputs.find(i => i.id === op.inputId);
    const eventStart = runtime.events.length;
    const requestStart = runtime.requests.length;
    const startedAt = Date.now();
    let result;
    appendFileSync(join(outputDir, "operations.jsonl"), JSON.stringify({ event: "operation-start", ...op, startedAt }) + "\n");
    try { result = await runtime.run({ config, request: input.request, operationId: op.id }); }
    catch { throw new Error("Calibration operation threw; stop and inspect the existing journal"); }
    const attempts = runtime.events.slice(eventStart).filter(e => e.type === "terminal").map(event => {
      const outcome = event.outcome;
      const parsed = runtime.parse(outcome.text ?? "", input.request);
      return { outcome, parsed, durationMs: outcome.finishedAt - outcome.startedAt,
        strictValid: Boolean(parsed.ok && outcome.status === "success"),
        nativeFinishReasonAvailable: outcome.nativeFinishReason !== undefined, tokenUsageAvailable: outcome.tokenUsage !== undefined };
    });
    const actualRequests = runtime.requests.slice(requestStart);
    if (journalFailed || actualCalls > 96 || actualRequests.length > 2) throw new Error("Experiment guard violated; stop and review");
    const predicted = result.parsed?.ok ? result.parsed.value.questionType : undefined;
    const row = { ...op, ...result, predicted, strictValidOutput: Boolean(result.parsed?.ok), semanticCorrect: predicted === input.expected,
      expected: input.expected, attempts, actualRequests, actualProviderCalls: operationCalls };
    rows.push(row);
    appendFileSync(join(outputDir, "operations.jsonl"), JSON.stringify(redact({ event: "operation-result", ...row }, config)) + "\n");
    if (["authentication", "configuration"].includes(result.providerOutcome?.failureClass)) {
      stopReason = "provider-configuration-or-authentication-failed";
      break;
    }
  }
  const summary = { ...summarize(rows), status: stopReason ? "stopped" : "completed", stopReason,
    actualProviderCalls: actualCalls, mode, experimentHash: plan.experimentHash };
  write("summary.json", summary);
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("node scripts/calibrate-question-type.mjs --config /private/path/provider.json --output /private/path/run [--live --confirm HASH]\nDefault: dry-run only. Config may instead use JARVIS_TYPE_CALIBRATION_CONFIG (path) or JARVIS_TYPE_CALIBRATION_CONFIG_JSON. JSON shape: {provider,selectedProvider:{provider,variables}} using the existing Intelligent/main selection. Omit provider to resolve selectedProvider.provider from production builtins. Programmatic callers can use resolveBuiltinProviderConfig(selectedProvider) with an in-memory localStorage selection. Review dry-run manifest before passing its experimentHash to --confirm. Live claims persist under .local/question-type-calibration-claims; never delete to reroll. New output directory required per invocation.");
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--live") options.live = true;
    else if (["--config", "--output", "--confirm"].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
    else throw new Error("Invalid arguments; use --help");
  }
  if (!options.output) throw new Error("--output is required");
  const configPath = options.config ?? process.env.JARVIS_TYPE_CALIBRATION_CONFIG;
  const config = JSON.parse(configPath ? readFileSync(configPath, "utf8") : process.env.JARVIS_TYPE_CALIBRATION_CONFIG_JSON ?? "null");
  const plan = createPlan(config);
  if (options.live && options.confirm !== plan.experimentHash) throw new Error("Live run requires reviewed dry-run experimentHash via --confirm");
  const result = await runExperiment({ config, outputDir: resolve(options.output), mode: options.live ? "live" : "dry-run", approvedHash: options.confirm });
  console.log(JSON.stringify({ mode: result.mode, experimentHash: result.experimentHash, operations: result.actualOperations ?? result.plannedOperations, attempts: result.actualProviderCalls ?? 0 }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(() => {
  // Provider configuration and exception messages can contain credentials; never print either.
  console.error("Calibration stopped. Check arguments/config, reviewed hash, output exclusivity and persistent claim. No automatic retry. Use --help for usage.");
  process.exitCode = 1;
});
