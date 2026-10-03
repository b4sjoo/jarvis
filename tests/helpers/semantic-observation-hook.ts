import assert from "node:assert/strict";
import vm from "node:vm";
import ts from "typescript";
import * as taxonomy from "../../src/lib/meeting/task-taxonomy.js";
import * as unit from "../../src/lib/meeting/logical-question-unit.js";
import * as ownership from "../../src/lib/meeting/logical-question-ownership.js";
import * as shadow from "../../src/lib/meeting/semantic-taxonomy-shadow.js";
import * as semantic from "../../src/lib/meeting/semantic-taxonomy-resolver.js";
import * as intent from "../../src/lib/meeting/semantic-interviewer-intent-resolver.js";
import { formatSemanticEmbeddingRuntimeTelemetryForTrace } from "../../src/lib/meeting/semantic-taxonomy-runtime.js";
import { calculateWordEquivalent } from "../../src/lib/meeting/transcript-fusion.js";
import { detectOpeningTaskRoute } from "../../src/lib/meeting/opening-route.js";

export interface SemanticSchedulingInput {
  eligible?: boolean; embeddingStatus?: string; parent?: boolean; stale?: boolean;
  // Embedding result vectors in request order ([unit] or [unit, relation]). Defaults to zero vectors.
  embeddings?: number[][];
  // 178/168 PC: Runtime Cross-checks admits the embedding observation. Off is the product default.
  runtimeCrossChecks?: boolean;
  // Debug and Recording are separate switches; neither admits the observation.
  debug?: boolean;
  recording?: boolean;
  // The shared SemanticTaxonomyRuntime to use instead of the recording stub.
  runtime?: unknown;
}

// The Hook's real scheduleQuestionRuntime and observer, bound to substituted
// formal schedulers, sinks and (unless one is supplied) a stub embedding runtime.
export function semanticSchedulingHook(source: string, input: SemanticSchedulingInput = {}) {
  const ast = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
  function declaration(name: string) {
    let found: ts.VariableDeclaration | ts.FunctionDeclaration | undefined;
    const visit = (n: ts.Node) => {
      if ((ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name?.getText(ast) === name) found ??= n;
      if (!found) ts.forEachChild(n, visit);
    };
    visit(ast); assert.ok(found, name); return found;
  }
  const turn = { id: "t", text: input.eligible === false ? "OK" : "Design a queue for concurrent tasks and explain the tradeoffs.",
    speaker: "them", source: "system-audio", isFinal: true, startedAt: 1, endedAt: 2 };
  const logicalQuestionUnit = { id: "q", revision: 1, sessionId: "s", runtimeEpoch: 1, currentTurnId: "t", sourceTurnIds: ["t"],
    normalizedText: turn.text, startedAt: 1, updatedAt: 2, sources: [{ turnId: "t", text: turn.text, startedAt: 1, endedAt: 2 }],
    compositionReasons: [], boundaryReason: "new-question", truncated: false };
  const contextState = { sessionId: "s", activeMeetingTask: input.parent ? { id: "task", parent: {
    id: "p", questionType: "general-system-design", playbookPhase: "design_framing", topic: "Queue", revisions: 1 } } : undefined };
  const events: any[] = [];
  let complete!: (value: unknown) => void;
  let authorize: (() => unknown) | undefined;
  const typeHandle = { operationId: "type" }, relationHandle = { operationId: "relation" };
  const env: Record<string, any> = { ...taxonomy, ...unit, ...ownership, ...shadow, ...semantic, ...intent,
    formatSemanticEmbeddingRuntimeTelemetryForTrace, calculateWordEquivalent, detectOpeningTaskRoute,
    contextManagerRef: { current: { getState: () => contextState } }, runtimeEpochRef: { current: 1 },
    debugModeRef: { current: input.debug ?? false },
    runtimeCrossChecksEnabledRef: { current: input.runtimeCrossChecks ?? false },
    logicalQuestionUnitRef: { current: logicalQuestionUnit },
    semanticEmbeddingRevisionRef: { current: 0 }, semanticTaxonomyEvidenceByTurnRef: { current: new Map() },
    readEffectiveSemanticTask: (task: unknown) => task,
    traceStoreRef: { current: { updateMetadata: (...args: unknown[]) => events.push(["metadata", ...args]),
      startStep: (...args: unknown[]) => { events.push(["start", ...args]); return "step"; },
      finishStep: (...args: unknown[]) => events.push(["finish", ...args]) } },
    // An inactive recorder is still present; it just writes nothing.
    sessionRecordingManagerRef: { current: {
      recordSemanticTaxonomyDecision: (value: unknown) => { if (input.recording ?? true) events.push(["taxonomy", value]); },
      recordInterviewerIntentSemanticDecision: (value: unknown) => { if (input.recording ?? true) events.push(["intent", value]); } } },
    recordSemanticEmbeddingRuntimeEvent: (value: unknown) => events.push(["telemetry", value]),
    semanticTaxonomyRuntimeRef: { current: input.runtime ?? { pinSession: (...args: unknown[]) => events.push(["pin", ...args]),
      getSnapshot: () => ({ readiness: "ready", modelVersion: "fixture" }),
      embed: (request: unknown, options: any) => {
        events.push(["embed", request, { ...options, onTelemetry: undefined }]);
        return new Promise(resolve => { complete = resolve; });
      } } },
    scheduleQuestionTypeAdjudication: (args: unknown) => { events.push(["type", args]); return typeHandle; },
    scheduleTaskRelationAdjudication: (args: any) => {
      authorize = args.authorizeSourceOperation;
      events.push(["relation", { ...args, authorizeSourceOperation: undefined }, authorize!()]);
      return relationHandle;
    },
  };
  const context = vm.createContext(env);
  const evaluate = (code: string) => vm.runInContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context);
  for (const name of ["VOICE_QUESTION_TYPE_PROMPT_HINT_RULES", "buildVoiceQuestionTypeStructuredHints", "buildSemanticInterviewerIntentRelationText", "toTaskRelationOperationAuthorization"]) {
    const node = declaration(name);
    env[name] = evaluate(`(${ts.isFunctionDeclaration(node) ? node.getText(ast) : node.initializer!.getText(ast)})`);
  }
  const loadCallback = (name: string) => {
    const node = declaration(name) as ts.VariableDeclaration;
    return evaluate(`(${(node.initializer as ts.CallExpression).arguments[0].getText(ast)})`);
  };
  const old = source.includes("const scheduleSemanticTaxonomyShadow =");
  if (!old) env.prepareSemanticTaxonomyObservation = loadCallback("prepareSemanticTaxonomyObservation");
  const scheduleQuestion = loadCallback(old ? "scheduleSemanticTaxonomyShadow" : "scheduleQuestionRuntime");
  // `scheduledTurn` gives one schedule its own turn object, as production does:
  // the Hook's completion handler keeps the turn it was scheduled with.
  const schedule = (scheduledTurn = turn) => {
    const result = scheduleQuestion({ turn: scheduledTurn, traceId: "trace", turnGateAction: input.eligible === false ? "ignore" : "answer-refresh", logicalQuestionUnit });
    assert.equal(result.questionType, typeHandle); assert.equal(result.taskRelation, relationHandle);
    return result;
  };
  return { env, events, turn, logicalQuestionUnit, contextState, loadCallback, schedule,
    completeEmbedding: () => complete, authorizeRelationSource: () => authorize!() };
}

export async function runSemanticScheduling(source: string, input: SemanticSchedulingInput = {}) {
  const { env, events, logicalQuestionUnit, contextState, schedule, completeEmbedding, authorizeRelationSource } =
    semanticSchedulingHook(source, input);
  schedule();
  const complete = completeEmbedding();
  if (complete) {
    if (input.stale) contextState.sessionId = "other";
    complete({ status: input.embeddingStatus ?? "success", embeddings: input.embeddings ?? [Array(384).fill(0), Array(384).fill(0)],
      telemetry: {}, cacheHit: false, reason: "fixture", durationMs: 5 });
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  env.logicalQuestionUnitRef.current = { ...logicalQuestionUnit, revision: 2 };
  const lateAuthorization = authorizeRelationSource();
  return JSON.parse(JSON.stringify({ events, lateAuthorization, embeddingRevision: env.semanticEmbeddingRevisionRef.current,
    evidence: [...env.semanticTaxonomyEvidenceByTurnRef.current.entries()] }));
}
