import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const file = ts.createSourceFile('hook.ts', readFileSync('src/hooks/useMeetingAssistant.ts', 'utf8'), ts.ScriptTarget.Latest, true);
let expression;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'committedSettlementAdvisorTaskSignals') {
    assert.equal(expression, undefined);
    expression = node.initializer.getText(file);
  }
  ts.forEachChild(node, visit);
}
visit(file);
assert.ok(expression);
const code = ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const source = { questionType: 'project-deep-dive', openingRoute: { kind: 'resume-walkthrough', commitParent: false },
  projectAnchor: 'Existing project hint', query: 'Original source' };

test('PG154 accepted settlement supersedes opening execution hints for every type without deleting source hints', () => {
  for (const type of ['project-deep-dive', 'behavioral', 'coding', 'general-system-design', 'ai-ml-system-design', 'field-knowledge', 'unknown']) {
    const result = vm.runInNewContext(code, { phaseControlledAdvisorTaskSignals: source,
      currentQuestionSettlement: { action: 'answer', questionType: type, typeMutationAuthorized: type !== 'unknown' },
      committedSettlementRelation: 'new-parent' });
    assert.equal(result.openingRoute, undefined);
    assert.equal(result.questionType, type);
    assert.equal(result.taskRelation, 'new-parent');
    assert.equal(result.projectAnchor, source.projectAnchor);
    assert.equal(result.query, source.query);
    assert.equal(source.openingRoute.commitParent, false, 'do not promote or mutate the old hint');
  }
});

test('PG154 a missing or non-adopted settlement retains the original opening path', () => {
  for (const settlement of [undefined, { action: 'ignore', questionType: 'project-deep-dive', typeMutationAuthorized: true },
    { action: 'answer', questionType: 'project-deep-dive', typeMutationAuthorized: false }]) {
    const result = vm.runInNewContext(code, { phaseControlledAdvisorTaskSignals: source,
      currentQuestionSettlement: settlement, committedSettlementRelation: undefined });
    assert.equal(result, source);
  }
});
