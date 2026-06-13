import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDiagramOverlayEvalTraceMetadata,
  readMeetingEvalTraceMetadata,
} from "../src/lib/meeting/eval-trace-metadata.js";

test("builds diagram overlay eval trace metadata from memory selection", () => {
  const metadata = buildDiagramOverlayEvalTraceMetadata({
    selectedEntryIds: ["mem_geo_index", "mem_geo_sharding"],
    selectedTitles: ["Geo index", "Geo sharding"],
    rejectedCount: 2,
    rejectSummary: [
      {
        reason: "diagram-overlay-question-type-blocked",
        count: 2,
        sampleEntryIds: ["mem_behavioral"],
        sampleTitles: ["Behavioral guide"],
      },
    ],
  });

  assert.deepEqual(metadata.selectedDiagramOverlayIds, [
    "mem_geo_index",
    "mem_geo_sharding",
  ]);
  assert.equal(metadata.rejectedDiagramOverlayCount, 2);
  assert.deepEqual(metadata.diagramOverlayRejectSummary, [
    {
      reason: "diagram-overlay-question-type-blocked",
      count: 2,
      sampleEntryIds: ["mem_behavioral"],
      sampleTitles: ["Behavioral guide"],
    },
  ]);
});

test("reads whiteboard, manual phase, and overlay metadata from trace sources", () => {
  const metadata = readMeetingEvalTraceMetadata([
    {
      manualPhaseFrom: "requirement_clarification",
      manualPhaseTo: "design_framing",
      manualPhaseTargetArtifact: "whiteboard",
      manualPhaseGuardStatus: "advanced",
      manualPhaseAdvanceCommitted: true,
    },
    {
      whiteboardArtifactId: "whiteboard_1",
      whiteboardArtifactRevision: 3,
      whiteboardArtifactDomainTrack: "general_sd",
      selectedDiagramOverlayIds: ["mem_overlay"],
      rejectedDiagramOverlayCount: 4,
      diagramOverlayRejectSummary: [
        {
          reason: "project-anchor-mismatch",
          count: 4,
          sampleEntryIds: ["mem_other_project"],
          sampleTitles: ["Other project"],
        },
      ],
    },
  ]);

  assert.equal(metadata.whiteboardArtifactId, "whiteboard_1");
  assert.equal(metadata.whiteboardArtifactRevision, 3);
  assert.equal(metadata.whiteboardArtifactDomainTrack, "general_sd");
  assert.equal(metadata.manualPhaseFrom, "requirement_clarification");
  assert.equal(metadata.manualPhaseTo, "design_framing");
  assert.equal(metadata.manualPhaseTargetArtifact, "whiteboard");
  assert.equal(metadata.manualPhaseGuardStatus, "advanced");
  assert.equal(metadata.manualPhaseAdvanceCommitted, true);
  assert.deepEqual(metadata.selectedDiagramOverlayIds, ["mem_overlay"]);
  assert.equal(metadata.rejectedDiagramOverlayCount, 4);
  assert.deepEqual(metadata.diagramOverlayRejectSummary, [
    {
      reason: "project-anchor-mismatch",
      count: 4,
      sampleEntryIds: ["mem_other_project"],
      sampleTitles: ["Other project"],
    },
  ]);
});
