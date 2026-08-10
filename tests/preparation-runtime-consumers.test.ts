import assert from "node:assert/strict";
import test from "node:test";
import {
  resolvePreparationRuntimeReinforcement,
  toPreparedSpeechBiasTerms,
} from "../src/lib/meeting/preparation-runtime-consumers.js";
import type {
  PreparationRuntimeContext,
  PreparationRuntimeProjection,
} from "../src/lib/meeting/preparation-runtime-context.js";
import type { PreparationRuntimeBrief } from "../src/lib/preparation/snapshot-types.js";

test("prepared company and round types outrank legacy brief defaults", () => {
  const context = createContext();
  const result = resolvePreparationRuntimeReinforcement(context, {
    targetCompany: "Legacy Company",
    targetCompanyNormalized: "legacy-company",
    companyLocked: false,
    interviewTypes: ["behavioral"],
    focusAreas: "legacy focus",
    notes: "legacy note",
  });

  assert.equal(result.enabled, true);
  assert.equal(result.effectiveInterviewBrief?.targetCompany, "Snowflake");
  assert.equal(result.effectiveInterviewBrief?.companyLocked, true);
  assert.deepEqual(result.effectiveInterviewBrief?.interviewTypes, [
    "coding",
    "ai-ml-system-design",
  ]);
  assert.equal(result.effectiveInterviewBrief?.focusAreas, "legacy focus");
  assert.equal(result.programmingLanguage?.value, "Java");
});

test("disabled and neutral contexts expose no prepared consumer values", () => {
  const disabled = createContext();
  disabled.capabilities.runtimeReinforcement.enabled = false;
  const result = resolvePreparationRuntimeReinforcement(disabled, {
    targetCompany: "Manual",
    companyLocked: true,
    interviewTypes: ["behavioral"],
    focusAreas: "",
    notes: "",
  });

  assert.equal(result.enabled, false);
  assert.equal(result.runtimeBrief, undefined);
  assert.deepEqual(result.speechBiasTerms, []);
  assert.equal(result.effectiveInterviewBrief?.targetCompany, "Manual");
});

test("prepared speech terms retain high-weight preparation provenance", () => {
  const terms = toPreparedSpeechBiasTerms(
    createContext().projections!.lowImpact.speechBiasTerms
  );
  assert.deepEqual(terms, [
    { term: "HNSW", source: "preparation", weight: "high" },
    { term: "H N S W", source: "preparation", weight: "high" },
  ]);
});

function createContext(): PreparationRuntimeContext {
  const runtimeBrief = projection<PreparationRuntimeBrief>("runtime-brief", {
    company: "Snowflake",
    role: "Senior Software Engineer",
    roundId: "round-1",
    roundTitle: "Technical",
    stage: "mixed",
    expectedInterviewTypes: ["coding", "ai-ml-system-design"],
    expectedTypePolicy: "restricted",
    preferredProgrammingLanguage: "Java",
    focusAreas: ["Distributed systems"],
    compactNotes: ["Keep answers concise"],
    unresolvedHighImpactAssumptions: [],
  });
  return {
    version: "meeting-preparation-context-v1",
    meetingSessionId: "meeting-1",
    preparationContextRevision: 2,
    selectionRevision: 3,
    mode: "prepared",
    loadState: "ready",
    createdAt: 1,
    pinnedSnapshot: {
      snapshotId: "snapshot-1",
      processId: "process-1",
      roundId: "round-1",
      version: 1,
      contentHash: "snapshot-hash",
      compilerVersion: "compiler-1",
      playbookRegistryVersion: "playbook-1",
      runtimeCapabilityVersion: "runtime-1",
      selectionRevision: 3,
      selectedAt: 1,
      artifactManifest: {
        version: "preparation-artifact-manifest-v1",
        artifacts: [],
      },
    },
    capabilities: {
      runtimeReinforcement: {
        version: "meeting-preparation-10b-v1",
        available: true,
        enabled: true,
      },
      personalizedGuidance: {
        version: "meeting-preparation-10c-v1",
        available: true,
        enabled: false,
        requiresRuntimeReinforcement: true,
      },
    },
    projections: {
      lowImpact: {
        runtimeBrief,
        questionTypePrior: projection("question-type", {
          expectedInterviewTypes: ["coding", "ai-ml-system-design"],
          expectedTypePolicy: "restricted",
        }),
        programmingLanguage: projection("language", "Java"),
        speechBiasTerms: [
          projection("speech", {
            canonicalTerm: "HNSW",
            aliases: ["H N S W"],
            statementId: "statement-1",
            statementRevision: 1,
            authority: "user-confirmed",
          }),
        ],
      },
      personalized: {
        strategy: projection("strategy", {
          priorities: [],
          risks: [],
          questionsToAsk: [],
          likelyBranches: [],
          timeAllocation: [],
        }),
        factEvidence: [],
        kmbEvidenceHints: [],
        openingItems: [],
        narrativeGraphs: [],
        playbookOverlays: [],
      },
    },
  };
}

function projection<T>(
  id: string,
  value: T
): PreparationRuntimeProjection<T> {
  return {
    projectionId: `snapshot-1:${id}`,
    snapshotId: "snapshot-1",
    preparationContextRevision: 2,
    value,
    artifactRefs: [],
  };
}
