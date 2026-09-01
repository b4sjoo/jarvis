import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  resolvePostModelContinuityAuthority,
} from "../src/lib/meeting/post-model-continuity-authority.js";

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
    /postModelContinuityAuthority\.lifecycleCommittedBeforeAdvisor[\s\S]*contextState\.taskRuntime\.parent \?\? promptInterviewTask/
  );
  assert.match(
    source,
    /sourceTransitionPrecommitted:\s*postModelContinuityAuthority\.lifecycleCommittedBeforeAdvisor/
  );
  assert.doesNotMatch(source, /parentMutationCommittedBeforeAdvisor/);
});
