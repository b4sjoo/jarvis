import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  resolvePostModelContinuityAuthority,
} from "../src/lib/meeting/post-model-continuity-authority.js";

test("existing Plan owner is independent of a new lifecycle receipt", () => {
  type Plan = NonNullable<Parameters<typeof resolvePostModelContinuityAuthority>[0]["validatedPlan"]>;
  const plan = {
    taskMutationPolicy: { kind: "update-parent-context" },
    taskRelation: "new-parent",
    taskSnapshot: { parent: { id: "parent" } },
  } as Plan;
  const resolve = (validatedPlan: Plan) => resolvePostModelContinuityAuthority({
    lifecycleCommittedBeforeAdvisor: false, validatedPlan,
  });
  assert.equal(resolve(plan).owner, "active-parent");
  assert.equal(resolve(plan).lifecycleCommittedBeforeAdvisor, false);
  assert.equal(resolve(plan).command, undefined);
  assert.equal(resolve({ ...plan, taskSnapshot: undefined }).owner, "settled-relation");
  assert.equal(resolve({ ...plan, taskMutationPolicy: { kind: "preserve" } }).owner, "settled-relation");
  assert.equal(resolve({ ...plan, taskMutationPolicy: { kind: "create-parent", type: "coding", topic: "new" } }).owner, "settled-relation");
  assert.equal(resolve({ ...plan, taskRelation: "child-probe" }).owner, "settled-relation");
  assert.equal(resolve({ ...plan, taskRelation: "child-probe", taskSnapshot: {
    ...plan.taskSnapshot!, child: { id: "child" },
  } as Plan["taskSnapshot"] }).owner, "active-child");
});

test("uses settled Relation only before a lifecycle command commits", () => {
  assert.deepEqual(
    resolvePostModelContinuityAuthority({
      command: "set-phase",
      lifecycleCommittedBeforeAdvisor: false,
      activeChild: false,
    }),
    {
      owner: "settled-relation",
      lifecycleCommittedBeforeAdvisor: false,
      reason: "no-precommitted-lifecycle",
    }
  );
});

test("projects committed lifecycle commands to their existing response owner", () => {
  assert.equal(
    resolvePostModelContinuityAuthority({
      command: "set-phase",
      lifecycleCommittedBeforeAdvisor: true,
      activeChild: false,
    }).owner,
    "active-parent"
  );
  assert.equal(
    resolvePostModelContinuityAuthority({
      command: "replace-parent",
      lifecycleCommittedBeforeAdvisor: true,
      activeChild: false,
    }).owner,
    "active-parent"
  );
  assert.equal(
    resolvePostModelContinuityAuthority({
      command: "attach-child",
      lifecycleCommittedBeforeAdvisor: true,
      activeChild: true,
    }).owner,
    "active-child"
  );
  assert.equal(
    resolvePostModelContinuityAuthority({
      command: "update-source-attachment",
      lifecycleCommittedBeforeAdvisor: true,
      activeChild: true,
    }).owner,
    "active-child"
  );
  assert.equal(
    resolvePostModelContinuityAuthority({
      command: "set-phase",
      lifecycleCommittedBeforeAdvisor: true,
      activeChild: true,
      phaseOwnerKind: "child",
    }).owner,
    "active-child"
  );
  assert.equal(
    resolvePostModelContinuityAuthority({
      command: "set-phase",
      lifecycleCommittedBeforeAdvisor: true,
      activeChild: false,
      phaseOwnerKind: "parent",
    }).owner,
    "active-parent"
  );
});

test("uses the committed runtime parent for post-model continuity", () => {
  const source = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
  assert.match(
    source,
    /postModelContinuityAuthority\.owner !== "settled-relation"[\s\S]*contextState\.taskRuntime\.parent \?\? promptInterviewTask/
  );
  assert.doesNotMatch(source, /sourceTransitionPrecommitted:/);
  assert.doesNotMatch(source, /function buildActiveInterviewChild/);
  assert.match(source, /Generated child output requires a committed child owner/);
  assert.doesNotMatch(source, /parentMutationCommittedBeforeAdvisor/);
});
