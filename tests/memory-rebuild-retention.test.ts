import assert from "node:assert/strict";
import test from "node:test";
import { planMemoryRebuildRetention } from "../src/lib/memory/rebuild-retention.js";

test("snapshot-linked stale entries are disabled while unlinked entries are deleted", () => {
  const plan = planMemoryRebuildRetention({
    currentEntries: [
      { id: "current", sourceIds: ["source-current"], projectId: "project-current" },
    ],
    currentSources: [{ id: "source-current", projectId: "project-current" }],
    currentProjectIds: ["project-current"],
    existingEntries: [
      { id: "current", sourceIds: ["source-current"], projectId: "project-current" },
      { id: "pinned", sourceIds: ["source-pinned"], projectId: "project-pinned" },
      { id: "orphan", sourceIds: ["source-orphan"], projectId: "project-orphan" },
    ],
    existingSources: [
      { id: "source-current", projectId: "project-current" },
      { id: "source-pinned", projectId: "project-pinned" },
      { id: "source-orphan", projectId: "project-orphan" },
    ],
    existingProjectIds: [
      "project-current",
      "project-pinned",
      "project-orphan",
    ],
    snapshotLinkedEntryIds: ["pinned"],
  });

  assert.deepEqual(plan.disableEntryIds, ["pinned"]);
  assert.deepEqual(plan.deleteEntryIds, ["orphan"]);
  assert.deepEqual(plan.deleteSourceIds, ["source-orphan"]);
  assert.deepEqual(plan.deleteProjectIds, ["project-orphan"]);
});

test("sources referenced by current entries survive even when omitted from source drafts", () => {
  const plan = planMemoryRebuildRetention({
    currentEntries: [
      { id: "current", sourceIds: ["source-referenced"], projectId: "project-a" },
    ],
    currentSources: [],
    currentProjectIds: [],
    existingEntries: [],
    existingSources: [
      { id: "source-referenced", projectId: "project-a" },
      { id: "source-unused", projectId: "project-unused" },
    ],
    existingProjectIds: ["project-a", "project-unused"],
    snapshotLinkedEntryIds: [],
  });

  assert.deepEqual(plan.deleteSourceIds, ["source-unused"]);
  assert.deepEqual(plan.deleteProjectIds, ["project-unused"]);
});

test("current entries are never disabled even when also linked by a snapshot", () => {
  const plan = planMemoryRebuildRetention({
    currentEntries: [{ id: "current", sourceIds: [] }],
    currentSources: [],
    currentProjectIds: [],
    existingEntries: [{ id: "current", sourceIds: [] }],
    existingSources: [],
    existingProjectIds: [],
    snapshotLinkedEntryIds: ["current"],
  });

  assert.deepEqual(plan.disableEntryIds, []);
  assert.deepEqual(plan.deleteEntryIds, []);
});
