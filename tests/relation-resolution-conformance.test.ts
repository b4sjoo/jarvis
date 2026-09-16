import assert from "node:assert/strict";
import test from "node:test";
import { decideOrderedTaskRelationResolution, type TaskRelationAffinityAdjudication } from "../src/lib/meeting/task-relation-split-shadow.js";
import { coordinateOrderedSettlement } from "../src/lib/meeting/ordered-settlement-coordinator.js";
import type { CanonicalQuestionType } from "../src/lib/meeting/task-taxonomy.js";

const types: CanonicalQuestionType[] = ["coding", "behavioral", "general-system-design", "ai-ml-system-design", "project-deep-dive", "field-knowledge"];
const longParents = new Set<CanonicalQuestionType>(["general-system-design", "ai-ml-system-design", "project-deep-dive"]);
const canBeChild = (parent: CanonicalQuestionType, current: CanonicalQuestionType) => longParents.has(parent) && (current === "coding" || current === "field-knowledge");
const canBeNewParent = (parent: CanonicalQuestionType, current: CanonicalQuestionType) => !(longParents.has(parent) && current === "field-knowledge");
function affinity(kind: "parent" | "child", decision: string | undefined, confidence: number): TaskRelationAffinityAdjudication | undefined {
  if (!decision) return undefined;
  return { schemaVersion: 1, affinityKind: kind, decision: decision as TaskRelationAffinityAdjudication["decision"],
    confidence, currentEvidenceSpans: ["current question"], branchEvidenceSpans: ["branch context"] };
}

for (const confidence of [0.6, 0.89, 0.99]) {
  test(`C2 approved different-type final matrix covers all600 topologies/affinity combinations at ${confidence}`, () => {
    let checked = 0;
    for (const parent of types) {
      const children: Array<CanonicalQuestionType | undefined> = [undefined,
        ...(longParents.has(parent) ? ["coding", "field-knowledge"] as const : [])];
      for (const child of children) for (const current of types) {
        if (current === (child ?? parent)) continue;
        for (const ap of ["related", "independent", "unclear", undefined]) {
          for (const ac of child ? ["related", "unrelated", "unclear", undefined] : [undefined]) {
            const expected = child && ac === "related" ? undefined
              : ap === "related" ? current === parent ? "resume-parent"
                : canBeChild(parent, current) ? "child-probe" : undefined
              : ap === "independent" ? canBeNewParent(parent, current) ? "new-parent" : undefined
              : current !== parent && !canBeChild(parent, current) ? "new-parent" : undefined;
            const result = decideOrderedTaskRelationResolution({ sourceKind: "voice", currentQuestionType: current,
              activeParentQuestionType: parent, activeChildQuestionType: child, hasActiveChild: !!child,
              parentAffinity: affinity("parent", ap, confidence), childAffinity: affinity("child", ac, confidence),
              finalizeWithNullHypothesis: true });
            const label = JSON.stringify({ parent, child, current, ap, ac });
            assert.equal(result.status, "resolved", label);
            assert.equal(result.relation, expected, label);
            if (!expected) assert.equal(result.stage, "runtime-matrix", label);
            if (child && expected === "child-probe") assert.equal(result.preserveActiveChild, false, label);
            checked++;
          }
        }
      }
    }
    assert.equal(checked, 600);
  });
}

test("C1 Canonical is categorical final authority, including results below0.85", () => {
  for (const confidence of [0, 0.6, 0.89]) {
    const result = decideOrderedTaskRelationResolution({ sourceKind: "voice", currentQuestionType: "coding",
      activeParentQuestionType: "coding", hasActiveChild: false,
      parentAffinity: affinity("parent", "independent", 0.99),
      canonical: { schemaVersion: 3, relation: "followup-parent", confidence,
        currentQuestionEvidenceSpans: ["current question"], parentEvidenceSpans: ["branch context"] },
      finalizeWithNullHypothesis: true });
    assert.equal(result.relation, "followup-parent");
    assert.equal(result.stage, "canonical-relation");
    assert.equal(result.confidence, confidence);
  }
});

test("C2 Field hard constraint applies to Canonical as well as the matrix", () => {
  for (const parent of types) {
    const result = decideOrderedTaskRelationResolution({ sourceKind: "screen", currentQuestionType: "field-knowledge",
      activeParentQuestionType: parent, hasActiveChild: false,
      canonical: { schemaVersion: 3, relation: "new-parent", confidence: 0.99,
        currentQuestionEvidenceSpans: ["current question"], parentEvidenceSpans: [] } });
    assert.equal(result.relation, longParents.has(parent) ? undefined : "new-parent");
    assert.equal(result.status, "resolved");
  }
  assert.equal(decideOrderedTaskRelationResolution({ sourceKind: "screen", currentQuestionType: "field-knowledge",
    hasActiveChild: false, finalizeWithNullHypothesis: true }).relation, "new-parent");
});

test("C3 inherited Type is not fabricated evidence against a child request", () => {
  const result = decideOrderedTaskRelationResolution({ sourceKind: "voice", currentQuestionType: "general-system-design",
    currentQuestionTypeInherited: true, activeParentQuestionType: "general-system-design", hasActiveChild: false,
    canonical: { schemaVersion: 3, relation: "child-probe", confidence: 0.89,
      currentQuestionEvidenceSpans: ["current question"], parentEvidenceSpans: ["branch context"] },
    finalizeWithNullHypothesis: true });
  assert.equal(result.relation, "followup-parent");
  assert.equal(result.stage, "source-topology-null-hypothesis");
  assert.equal(result.currentQuestionTypeInherited, true);
});

test("C4 recorded B tuple ends Answer-only without relabeling its existing Coding child", () => {
  const result = decideOrderedTaskRelationResolution({ sourceKind: "voice", currentQuestionType: "project-deep-dive",
    activeParentQuestionType: "ai-ml-system-design", activeChildQuestionType: "coding", hasActiveChild: true,
    childAffinity: affinity("child", "related", 0.88),
    canonical: { schemaVersion: 3, relation: "child-probe", confidence: 0.89,
      currentQuestionEvidenceSpans: ["current question"], parentEvidenceSpans: ["branch context"] },
    finalizeWithNullHypothesis: true });
  assert.equal(result.status, "resolved");
  assert.equal(result.relation, undefined);
  assert.equal(result.reason, "canonical-topology-incompatible");
});

test("C5 final evidence does not acquire early release permission", () => {
  const input = { sourceKind: "voice" as const, currentQuestionType: "coding",
    activeParentQuestionType: "ai-ml-system-design", hasActiveChild: false,
    parentAffinity: affinity("parent", "related", 0.89) };
  assert.equal(decideOrderedTaskRelationResolution(input).status, "unresolved");
  assert.equal(decideOrderedTaskRelationResolution({ ...input, finalizeWithNullHypothesis: true }).relation, "child-probe");
  const coordinator = coordinateOrderedSettlement({ ...input,
    activeMeetingTask: { parent: { id: "p", questionType: "ai-ml-system-design" } } as any });
  assert.equal(coordinator.relation.relation, "child-probe");
});

test("C5 an explicit supported parent retype retains its human capability, not an automatic bypass", () => {
  const input = { sourceKind: "voice" as const, currentQuestionType: "project-deep-dive",
    activeParentQuestionType: "behavioral", hasActiveChild: false,
    canonical: { schemaVersion: 3 as const, relation: "followup-parent" as const, confidence: 0.89,
      currentQuestionEvidenceSpans: ["current question"], parentEvidenceSpans: ["branch context"] },
    finalizeWithNullHypothesis: true };
  assert.equal(decideOrderedTaskRelationResolution(input).relation, undefined);
  assert.equal(decideOrderedTaskRelationResolution({ ...input, allowParentRetype: true }).relation, "followup-parent");
  assert.equal(decideOrderedTaskRelationResolution({ ...input, currentQuestionType: "field-knowledge",
    activeParentQuestionType: "general-system-design", allowParentRetype: true }).relation, undefined);
});
