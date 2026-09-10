import type { PreparationRuntimeArtifactRef, PreparationRuntimeContext, PreparationRuntimeProjection } from "../src/lib/meeting/preparation-runtime-contracts.js";

import assert from "node:assert/strict";
import test from "node:test";
import {
  resolvePreparationPersonalizedGuidance,
  resolvePreparationRuntimeReinforcement,
  toAdvisorPersonalizedPreparationEvidence,
  toPreparedSpeechBiasTerms,
} from "../src/lib/meeting/preparation-runtime-consumers.js";

import type { PreparationRuntimeBrief } from "../src/lib/preparation/snapshot-types.js";

test("prepared company and round types outrank legacy brief defaults", () => {
  const context = createContext();
  const result = resolvePreparationRuntimeReinforcement(context, {
    targetCompany: "Legacy Company",
    targetCompanyNormalized: "legacy-company",
    companyLocked: false,
    interviewTypes: ["behavioral"],
  });

  assert.equal(result.enabled, true);
  assert.equal(result.effectiveInterviewBrief?.targetCompany, "Snowflake");
  assert.equal(result.effectiveInterviewBrief?.companyLocked, true);
  assert.deepEqual(result.effectiveInterviewBrief?.interviewTypes, [
    "coding",
    "ai-ml-system-design",
  ]);
  assert.equal(
    "focusAreas" in (result.effectiveInterviewBrief ?? {}),
    false
  );
  assert.equal(result.programmingLanguage?.value, "Java");
});

test("disabled and neutral contexts expose no prepared consumer values", () => {
  const disabled = createContext();
  disabled.capabilities.runtimeReinforcement.enabled = false;
  const result = resolvePreparationRuntimeReinforcement(disabled, {
    targetCompany: "Manual",
    companyLocked: true,
    interviewTypes: ["behavioral"],
  });

  assert.equal(result.enabled, false);
  assert.equal(result.runtimeBrief, undefined);
  assert.deepEqual(result.speechBiasTerms, []);
  assert.equal(result.effectiveInterviewBrief?.targetCompany, "Manual");
  assert.deepEqual(
    result.questionTypePriorObservation?.canonicalTypes,
    ["behavioral"]
  );
  assert.equal(
    result.questionTypePriorObservation?.source,
    "interview-brief"
  );
});

test("preparation type adaptation preserves field knowledge and separates personal logistics policy", () => {
  const context = createContext();
  context.projections!.lowImpact.questionTypePrior.value.expectedInterviewTypes = [
    "field-knowledge",
    "personal-logistics",
  ];

  const result = resolvePreparationRuntimeReinforcement(context);

  assert.deepEqual(result.effectiveInterviewBrief?.interviewTypes, []);
  assert.deepEqual(result.questionTypePriorObservation, {
    source: "preparation-snapshot",
    sourceId: "snapshot-1:question-type",
    rawTypes: ["field-knowledge", "personal-logistics"],
    canonicalTypes: ["field-knowledge"],
    policyOnlyTypes: ["personal-logistics"],
    unsupportedTypes: [],
    expectedTypePolicy: "restricted",
    adapterDisposition: "canonical-and-policy",
    legacyInterviewBriefTypes: [],
  });
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

test("personalized guidance selects only matching family, project, and playbook artifacts", () => {
  const context = createContext();
  context.capabilities.personalizedGuidance.enabled = true;
  const guidance = resolvePreparationPersonalizedGuidance(context, {
    questionType: "project-deep-dive",
    taskRelation: "followup-parent",
    playbookId: "project_deep_dive",
    playbookPhase: "architecture_decision",
    openingRoute: {
      kind: "project-intro",
      source: "test",
      projectAnchor: "agentic-memory",
      commitParent: true,
    },
    projectAnchor: "agentic-memory",
    query: "Explain the Agentic Memory architecture and tradeoffs",
  });

  assert.equal(guidance.enabled, true);
  assert.deepEqual(guidance.factEvidence.map((item) => item.value.statementId), [
    "statement-agentic",
  ]);
  assert.deepEqual(guidance.kmbEvidenceHints.map((item) => item.value.entryId), [
    "kmb-agentic",
  ]);
  assert.equal(guidance.openingItems[0]?.value.subjectId, "agentic-memory");
  assert.equal(guidance.narratives[0]?.subjectId, "agentic-memory");
  assert.equal(
    guidance.playbookOverlay?.value.canonicalPlaybookId,
    "project_deep_dive"
  );
  assert.ok(guidance.strategy?.value.likelyBranches?.length);

  const promptEvidence = toAdvisorPersonalizedPreparationEvidence(guidance);
  assert.equal(promptEvidence?.factEvidence[0]?.ownership, "candidate-owned");
  assert.equal(promptEvidence?.playbookOverlay?.expectedInterviewType, "project-deep-dive");
});

test("personalized guidance fails closed when its capability is disabled", () => {
  const guidance = resolvePreparationPersonalizedGuidance(createContext(), {
    questionType: "project-deep-dive",
    playbookId: "project_deep_dive",
    query: "Agentic Memory",
  });

  assert.equal(guidance.enabled, false);
  assert.deepEqual(guidance.factEvidence, []);
  assert.equal(toAdvisorPersonalizedPreparationEvidence(guidance), undefined);
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
        strategy: projection(
          "strategy",
          {
            priorities: ["Explain the architecture clearly"],
            risks: ["Do not overclaim ownership"],
            questionsToAsk: ["Which component should I expand?"],
            likelyBranches: ["Tradeoff follow-up"],
            timeAllocation: ["Start with a concise overview"],
          },
          [
            artifact("strategy/priorities/one"),
            artifact("strategy/risks/one"),
            artifact("strategy/questionsToAsk/one"),
            artifact("strategy/likelyBranches/one"),
            artifact("strategy/timeAllocation/one"),
          ]
        ),
        factEvidence: [
          projection(
            "fact-agentic",
            {
              statementId: "statement-agentic",
              statementRevision: 1,
              domain: "project-evidence",
              content: "I designed the Agentic Memory consolidation API.",
              ownership: "candidate-owned",
              allowedWording: "I designed the consolidation API.",
              prohibitedWording: ["I built the platform alone."],
              allowedInterviewFamilies: ["project-deep-dive"],
              sourceIds: ["material-agentic"],
            },
            [artifact("evidence/statement-agentic")]
          ),
          projection(
            "fact-behavioral",
            {
              statementId: "statement-behavioral",
              statementRevision: 1,
              domain: "candidate-fact",
              content: "I resolved a stakeholder conflict.",
              ownership: "candidate-owned",
              prohibitedWording: [],
              allowedInterviewFamilies: ["behavioral"],
              sourceIds: ["material-behavioral"],
            },
            [artifact("evidence/statement-behavioral")]
          ),
        ],
        kmbEvidenceHints: [
          projection(
            "kmb-agentic",
            {
              entryId: "kmb-agentic",
              title: "Agentic Memory architecture",
              contentHash: "hash-agentic",
            },
            [artifact("evidence-index/curated-kmb/kmb-agentic")]
          ),
          projection(
            "kmb-throttling",
            {
              entryId: "kmb-throttling",
              title: "Distributed throttling",
              contentHash: "hash-throttling",
            },
            [artifact("evidence-index/curated-kmb/kmb-throttling")]
          ),
        ],
        openingItems: [
          projection(
            "opening-agentic",
            {
              graphId: "graph-agentic",
              nodeId: "node-intro",
              subjectKind: "project",
              subjectId: "agentic-memory",
              nodeKind: "intro-30s",
              title: "Agentic Memory intro",
              renderedDraft: "I built durable context for agents.",
              statementIds: ["statement-agentic"],
            },
            [artifact("opening/graph-agentic/node-intro")]
          ),
        ],
        narrativeGraphs: [
          projection(
            "narrative-agentic",
            {
              graphId: "graph-agentic",
              graphRevision: 1,
              subjectKind: "project",
              subjectId: "agentic-memory",
              nodes: [
                {
                  nodeId: "node-architecture",
                  kind: "architecture",
                  title: "Architecture",
                  content: "Extraction and mutation are separated.",
                  statementIds: ["statement-agentic"],
                },
              ],
              edges: [],
            },
            [artifact("narratives/graph-agentic/nodes/node-architecture")]
          ),
        ],
        playbookOverlays: [
          projection(
            "overlay-project",
            {
              canonicalPlaybookId: "project_deep_dive",
              expectedInterviewType: "project-deep-dive",
              evidenceStatementIds: ["statement-agentic"],
              companyCriteria: ["Explain customer impact"],
              prohibitedOverclaims: ["Do not invent scale"],
            },
            [artifact("playbooks/project-deep-dive")]
          ),
        ],
      },
    },
  };
}

function projection<T>(
  id: string,
  value: T,
  artifactRefs: PreparationRuntimeArtifactRef[] = []
): PreparationRuntimeProjection<T> {
  return {
    projectionId: `snapshot-1:${id}`,
    snapshotId: "snapshot-1",
    preparationContextRevision: 2,
    value,
    artifactRefs,
  };
}

function artifact(artifactPath: string): PreparationRuntimeArtifactRef {
  return {
    artifactId: `artifact:${artifactPath}`,
    lineageKey: `lineage:${artifactPath}`,
    artifactPath,
    section: artifactPath.split("/")[0] as PreparationRuntimeArtifactRef["section"],
    contentHash: `hash:${artifactPath}`,
    sourceRefs: [],
  };
}
