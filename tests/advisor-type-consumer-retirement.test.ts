import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { buildEffectiveAdvisorSettlementView } from "../src/lib/meeting/settled-advisor-execution-plan.js";
import { resolveMeetingAnswerProfile } from "../src/lib/meeting/meeting-answer.js";
import type { CanonicalQuestionType } from "../src/lib/meeting/task-taxonomy.js";
import type { CurrentQuestionSettlementDecision } from "../src/lib/meeting/current-question-settlement.js";

const source = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
const start = source.indexOf("// COMMITTED_SETTLEMENT_CONSUMER_BARRIER");
const end = source.indexOf("    const advisorAskFrame =", start);
assert.ok(start >= 0 && end > start);
const consumer = ts.transpileModule(
  `${source.slice(start, end)}\n({ advisorQuestionType, advisorAnswerProfile, currentQuestionSettlement });`,
  { compilerOptions: { target: ts.ScriptTarget.ES2020 } }
).outputText;

function settlement(questionType: CanonicalQuestionType): CurrentQuestionSettlementDecision {
  return {
    settlementId: "settled", logicalQuestionUnitId: "question", revision: 2,
    sessionId: "session", runtimeEpoch: 1, sourceKind: "voice",
    sourceTurnIds: ["turn"], sourceObservationIds: [], sourceHash: "source",
    questionType, relation: "new-parent", action: "answer",
    evidenceMode: "hypothetical-design", authority: "deterministic-fast-path",
    authoritySource: "accepted-transcript", typeAuthoritySource: "deterministic-fast-path",
    relationAuthoritySource: "deterministic-fast-path", actionAuthoritySource: "deterministic-fast-path",
    typeMutationAuthorized: true, relationMutationAuthorized: true,
    parentMutationAuthorized: true, responseAuthorized: true, confidence: 1,
    manualCorrectionRevision: 0, rejectedProposals: [], reasons: [],
  };
}

test("the production type consumer initializes from the effective settlement only", () => {
  const ast = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
  const initializers: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "advisorQuestionType") {
      initializers.push(node.initializer?.getText(ast) ?? "");
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.deepEqual(initializers, ["effectiveAdvisorSettlementView.questionType"]);
});

test("actual consumer keeps settled types and answer profiles despite conflicting local fallback", () => {
  for (const type of ["coding", "behavioral", "field-knowledge", "general-system-design", "ai-ml-system-design", "project-deep-dive"] as const) {
    for (const sourceKind of ["voice", "screen"] as const) {
      const current = { ...settlement(type), sourceKind };
      const context = { taskRuntime: { revision: 1 }, activeMeetingTask: undefined };
      const result = vm.runInNewContext(consumer, {
        currentQuestionSettlement: current,
        originalPromptContext: context, promptContext: context,
        preSettlementAdvisorFallback: { questionType: "unknown", relation: "unknown" },
        transientPersonalStatusDecision: undefined,
        advisorJob: {}, traceId: undefined,
        buildEffectiveAdvisorSettlementView, resolveMeetingAnswerProfile,
      });
      assert.equal(result.advisorQuestionType, type);
      assert.deepEqual(result.advisorAnswerProfile, resolveMeetingAnswerProfile(type));
      assert.equal(result.currentQuestionSettlement.logicalQuestionUnitId, "question");
    }
  }
});

test("the no-LQU trigger gate and live ancillary signal producer remain", () => {
  assert.match(source, /!force\s*&&\s*!runtimeTypeAdjudicationOutputAuthorized\s*&&\s*!advisorJob\.logicalQuestionUnit\s*&&\s*!advisorEngineRef\.current\.shouldRequestSuggestion\(latestTurn\)/);
  assert.match(source, /function resolveAdvisorTaskSignals\(/);
  assert.match(source, /query: buildFocusedAdvisorTaskQuery\(context, latestUsefulText\)/);
});
