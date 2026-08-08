import assert from "node:assert/strict";
import test from "node:test";
import {
  formatPreparationMaterialScope,
  formatPreparationMaterialType,
  materialsForActiveRound,
} from "../src/lib/preparation/material-presentation.js";
import type { PreparationMaterial } from "../src/lib/preparation/types.js";

test("projects process-wide and active-round materials only", () => {
  const processMaterial = material("process", { kind: "workspace" });
  const activeMaterial = material("active", {
    kind: "round",
    roundId: "round-1",
  });
  const otherMaterial = material("other", {
    kind: "round",
    roundId: "round-2",
  });

  assert.deepEqual(
    materialsForActiveRound(
      [processMaterial, activeMaterial, otherMaterial],
      "round-1"
    ).map((entry) => entry.id),
    ["process", "active"]
  );
  assert.deepEqual(
    materialsForActiveRound(
      [processMaterial, activeMaterial, otherMaterial],
      undefined
    ).map((entry) => entry.id),
    ["process"]
  );
});

test("uses human-readable material types without changing MIME provenance", () => {
  const docx = material("docx", { kind: "workspace" }, {
    extension: "docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const markdown = material("markdown", { kind: "workspace" }, {
    extension: "md",
    mimeType: "text/markdown",
  });

  assert.equal(formatPreparationMaterialType(docx), "DOCX");
  assert.equal(formatPreparationMaterialType(markdown), "Markdown");
  assert.equal(
    docx.mimeType,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
});

test("uses an explicit entire-process scope label", () => {
  const roundTitles = new Map([["round-1", "Coding 1"]]);

  assert.equal(
    formatPreparationMaterialScope({ kind: "workspace" }, roundTitles),
    "Entire process"
  );
  assert.equal(
    formatPreparationMaterialScope(
      { kind: "round", roundId: "round-1" },
      roundTitles
    ),
    "Coding 1"
  );
});

function material(
  id: string,
  scope: PreparationMaterial["scope"],
  override: Partial<PreparationMaterial> = {}
): PreparationMaterial {
  return {
    id,
    workspaceId: "workspace-1",
    scope,
    displayName: `${id}.pdf`,
    originalFileName: `${id}.pdf`,
    mimeType: "application/pdf",
    extension: "pdf",
    sizeBytes: 100,
    checksumSha256: `checksum-${id}`,
    storageRelativePath: `materials/${id}/original.pdf`,
    status: "received",
    createdAt: 1,
    updatedAt: 1,
    ...override,
  };
}
