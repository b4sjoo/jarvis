import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { AIResponseEventBuilder, coordinateAIResponseAttempts } from "../src/lib/functions/ai-response-events.js";
import { consumeRuntimeInferenceResponse } from "../src/lib/meeting/runtime-inference-response.js";

function productionFunction(file: string, name: string, env: Record<string, unknown>): any {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const node = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, `missing production function ${name}`);
  const code = node.getText(source).replace(/^export\s+/, "") + `\n${name};`;
  return vm.runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, env);
}

const identity = {
  requestId: "type-op", executionPlanId: "type-op", modelId: "intelligent",
  sessionId: "meeting", runtimeEpoch: 1, logicalQuestionUnitId: "lqu", logicalQuestionRevision: 1,
};

test("production transport gives retry remaining time instead of another full timeout", async () => {
  let now = 1000;
  const budgets: number[] = [];
  const fetchEvents = productionFunction("src/lib/functions/ai-response.function.ts", "fetchAIResponseEvents", {
    Date: { now: () => now },
    resolveAIResponseExecutionIdentity: () => identity,
    coordinateAIResponseAttempts: (input: any) => coordinateAIResponseAttempts({ ...input, now: () => now }),
    fetchAIResponseAttemptEvents: async function* (params: any, attempt: any) {
      budgets.push(params.requestOptions.timeoutMs);
      const builder = new AIResponseEventBuilder("p", attempt, now);
      if (attempt.attemptNumber === 1) {
        now += 400;
        yield builder.terminal({ status: "failed", failureClass: "provider-http", retryable: true, statusCode: 503 }, now);
      } else {
        yield builder.content("ok", now);
        yield builder.terminal({ status: "success", retryable: false }, now);
      }
    },
  });
  const result = await consumeRuntimeInferenceResponse({
    responseEvents: fetchEvents({
      selectedProvider: { provider: "p" },
      requestOptions: { timeoutMs: 1000, retryPolicy: { maxAttempts: 2 }, readRetryDeadlineAt: () => 1800 },
    }),
    signal: new AbortController().signal, operationLabel: "Type",
  });
  assert.deepEqual(budgets, [1000, 400]);
  assert.equal(result.rawOutput, "ok");
  assert.equal(result.providerOutcome.attemptNumber, 2);
  assert.equal(result.providerOutcome.requestId, identity.requestId);
});
