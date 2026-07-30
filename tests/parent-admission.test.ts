import assert from "node:assert/strict";
import test from "node:test";
import {
  decideParentAdmission,
  formatParentAdmissionForTrace,
} from "../src/lib/meeting/parent-admission.js";
import type { ActiveInterviewParent } from "../src/lib/meeting/types.js";

test("keeps logistics append-only and unresolved questions provisional", () => {
  const logistics = decideParentAdmission({
    relation: "logistics",
    questionType: "project-deep-dive",
    mutationAuthorized: true,
  });
  const unresolved = decideParentAdmission({
    relation: "unknown",
    questionType: "unknown",
    mutationAuthorized: true,
  });

  assert.equal(logistics.action, "append-only");
  assert.equal(logistics.mutationAuthorized, false);
  assert.equal(unresolved.action, "provisional");
  assert.equal(unresolved.durable, false);
});

test("allows a clear technical question to reseed only a provisional parent", () => {
  const provisionalParent = makeParent({
    admission: {
      durability: "provisional",
      action: "create-parent",
      authoritySource: "legacy-provisional",
      sourceTurnIds: ["turn-old"],
      sourceObservationIds: [],
      reason: "legacy-weak-parent",
      admittedAt: 10,
    },
  });
  const durableParent = makeParent();

  const reseed = decideParentAdmission({
    existingParent: provisionalParent,
    relation: "new-parent",
    questionType: "project-deep-dive",
    mutationAuthorized: true,
  });
  const replace = decideParentAdmission({
    existingParent: durableParent,
    relation: "new-parent",
    questionType: "project-deep-dive",
    mutationAuthorized: true,
  });

  assert.equal(reseed.action, "reseed-parent");
  assert.deepEqual(reseed.invalidatedState, [
    "project-binding",
    "fact-anchors",
    "playbook-phase",
    "child",
    "artifacts",
  ]);
  assert.equal(replace.action, "create-parent");
  assert.equal(
    formatParentAdmissionForTrace(reseed).parentAdmissionAction,
    "reseed-parent"
  );
});

function makeParent(
  patch: Partial<ActiveInterviewParent> = {}
): ActiveInterviewParent {
  return {
    id: "parent-a",
    source: "voice",
    stableKind: "project-deep-dive",
    topic: "An earlier project",
    playbookPhase: "project_narrative",
    phaseProgress: { project_narrative: true },
    supportedFactAnchors: [],
    createdAt: 10,
    updatedAt: 10,
    revisions: 1,
    ...patch,
  };
}
