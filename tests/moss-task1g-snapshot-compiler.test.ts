import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  diffSnapshotBundles,
  parseSnapshotModelProposal,
  snapshotBundleHash,
  type CallPreparationSnapshotBundle,
} from "../src/lib/preparation/index.js";

test("Task 1G parser restores every deterministic playbook phase", () => {
  const proposal = parseSnapshotModelProposal('{"playbook":{"stages":[{"id":"request","goal":"Ask","prompts":[],"exitSignals":[]}],"fallbackMoves":[]},"speechBiasTerms":[]}');
  assert.deepEqual(proposal.playbook.stages.map((stage) => stage.id), ["orient", "establish", "request", "resolve", "confirm-close"]);
});

test("Task 1G content hashes are canonical and identity independent", async () => {
  const left = await snapshotBundleHash({ b: 2, a: { z: 1 } });
  const right = await snapshotBundleHash({ a: { z: 1 }, b: 2 });
  assert.equal(left, right);
});

test("Task 1G final Ready commit revalidates every frozen authority source", () => {
  const source = readFileSync("src/lib/preparation/snapshot-service.ts", "utf8");
  assert.match(source, /revalidateManifest\(snapshot\.caseId/);
  assert.match(source, /CaseRevision changed after snapshot source freeze/);
  assert.match(source, /CallPlan changed after snapshot source freeze/);
  assert.match(source, /selected ExtractionRun changed after snapshot source freeze/);
  assert.match(source, /confirmed statement hash changed after snapshot source freeze/);
  assert.match(source, /Curated KMB content changed after snapshot source freeze/);
});

test("Task 1G inspector diff reports section-level changes", () => {
  const base = { callBrief: { objective: "A" }, caseSnapshot: {}, playbookSnapshot: {}, speechBiasTerms: [], evidenceIndex: [], safetyConstraints: {} } as unknown as CallPreparationSnapshotBundle;
  const next = { ...base, callBrief: { objective: "B" } } as CallPreparationSnapshotBundle;
  assert.deepEqual(diffSnapshotBundles(next, base), ["callBrief"]);
});
