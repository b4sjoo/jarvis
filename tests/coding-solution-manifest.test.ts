import assert from "node:assert/strict";
import test from "node:test";
import {
  extractCodingSolutionManifest,
  validateCodingSolutionManifestPhase,
} from "../src/lib/meeting/coding-solution-manifest.js";

const manifest = {
  version: 1,
  baseline: {
    approach: "Check every substring.",
    dataStructures: ["set"],
    time: "O(n^3)",
    space: "O(n)",
  },
  optimized: {
    approach: "Use a sliding window.",
    dataStructures: ["map"],
    time: "O(n)",
    space: "O(k)",
  },
  sameSolution: false,
  reason: "The sliding window removes repeated enumeration.",
  visibleCandidate: "baseline",
};

test("extracts a hidden bounded manifest from visible meeting content", () => {
  const extraction = extractCodingSolutionManifest(
    `Answer:\nStart with direct enumeration.\n\nCode:\n\`\`\`ts\nreturn 0;\n\`\`\`\n<CODING_SOLUTION_MANIFEST>${JSON.stringify(
      manifest
    )}</CODING_SOLUTION_MANIFEST>`
  );

  assert.equal(extraction.disposition, "parsed");
  assert.doesNotMatch(extraction.displayContent, /CODING_SOLUTION_MANIFEST/);
  assert.equal(extraction.manifest?.optimized.time, "O(n)");
});

test("authorizes manifest candidates according to the committed phase", () => {
  const extraction = extractCodingSolutionManifest(
    `Answer:\nBaseline.\n<CODING_SOLUTION_MANIFEST>${JSON.stringify(
      manifest
    )}</CODING_SOLUTION_MANIFEST>`
  );
  const baseline = validateCodingSolutionManifestPhase({
    phase: "baseline_reasoning",
    extraction,
  });
  const implementation = validateCodingSolutionManifestPhase({
    phase: "implementation_validation",
    extraction,
  });

  assert.equal(baseline.authorized, true);
  assert.equal(baseline.codeMutationAuthorized, true);
  assert.equal(implementation.authorized, false);
  assert.equal(
    implementation.reason,
    "optimized-visible-candidate-mismatch"
  );
});
