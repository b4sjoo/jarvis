import assert from "node:assert/strict";
import test from "node:test";
import {
  auditCuratedMemoryEvidence,
  renderKmbEvidenceAuditMarkdown,
} from "../src/lib/memory/evidence-audit.js";
import { parseCuratedMemoryDraft } from "../src/lib/memory/parser.js";

test("audits source, link, role, and project evidence coverage without memory text", () => {
  const draft = parseCuratedMemoryDraft(
    {
      path: "fixture.md",
      content: `
\`\`\`yaml
sources:
  - id: source_project
    title: Project source
    collection: project_docs
    sourceRole: working_summary
    scope: project
    projectId: project-a
    projectName: Project A
    curationStatus: curated
\`\`\`

\`\`\`yaml
- id: evidence_project
  sourceId: source_project
  type: implementation_note
  title: Project implementation and architecture decision
  content: Implemented the request pipeline, debugged a routing failure, compared alternatives, and measured latency impact.
  scope: project
  projectId: project-a
  projectName: Project A
  tags: [implementation, architecture, debugging, tradeoff, impact]
  keywords: [request pipeline, routing failure, alternatives, latency]
  enabled: true
  curationStatus: curated
  relatedEntryIds: [guidance_project]
  evidenceEntryIds: []
\`\`\`

\`\`\`yaml
- id: guidance_project
  sourceId: source_project
  type: field_note
  title: Project guidance
  content: Explain the design without inventing implementation details.
  scope: project
  projectId: project-a
  projectName: Project A
  enabled: true
  curationStatus: curated
  relatedEntryIds: [evidence_project]
  evidenceEntryIds: [evidence_project]
\`\`\`
`,
    },
    1
  );
  const report = auditCuratedMemoryEvidence({ drafts: [draft], now: 2 });

  assert.equal(report.issueCounts.error, 0);
  assert.equal(report.roleCounts["fact-evidence"], 1);
  assert.equal(report.roleCounts.guidance, 1);
  assert.equal(report.anchorEligibleCount, 1);
  assert.deepEqual(report.projects[0]?.missingFamilies, []);
  assert.doesNotMatch(
    renderKmbEvidenceAuditMarkdown(report),
    /Implemented the request pipeline/
  );
});

test("reports missing sources, links, and guidance that looks like personal evidence", () => {
  const draft = parseCuratedMemoryDraft(
    {
      path: "broken.md",
      content: `
\`\`\`yaml
- id: broken_guidance
  sourceId: source_missing
  type: field_note
  title: Broken guidance
  content: We implemented a private retry mechanism.
  scope: project
  projectId: project-b
  projectName: Project B
  enabled: true
  curationStatus: curated
  relatedEntryIds: [entry_missing]
  evidenceEntryIds: []
\`\`\`
`,
    },
    1
  );
  const report = auditCuratedMemoryEvidence({ drafts: [draft], now: 2 });
  const codes = report.issues.map((issue) => issue.code);

  assert.ok(codes.includes("missing-source"));
  assert.ok(codes.includes("missing-related-entry"));
  assert.ok(codes.includes("guidance-contains-first-person-claim"));
});

test("rejects query-independent negative prompts in advisor-visible memory", () => {
  const draft = parseCuratedMemoryDraft(
    {
      path: "negative-prompt.md",
      content: `
\`\`\`yaml
sources:
  - id: source_project
    title: Project source
    collection: project_docs
    sourceRole: working_summary
    scope: project
    projectId: project-a
    projectName: Project A
    curationStatus: curated
\`\`\`

\`\`\`yaml
- id: evidence_project
  sourceId: source_project
  type: implementation_note
  title: Project implementation
  content: Implemented per-item parsing. Do not claim a DLQ or retry queue.
  scope: project
  projectId: project-a
  projectName: Project A
  enabled: true
  curationStatus: curated
\`\`\`
`,
    },
    1
  );
  const report = auditCuratedMemoryEvidence({ drafts: [draft], now: 2 });

  assert.ok(
    report.issues.some(
      (issue) => issue.code === "query-independent-negative-prompt"
    )
  );
});

test("requires autobiographical templates to link anchor-eligible evidence", () => {
  const draft = parseCuratedMemoryDraft(
    {
      path: "template-closure.md",
      content: `
\`\`\`yaml
sources:
  - id: source_profile
    title: Profile
    collection: profiles
    sourceRole: promotion_doc
    scope: global
    curationStatus: curated
\`\`\`

\`\`\`yaml
- id: story_template
  sourceId: source_profile
  type: answer_template
  title: Behavioral story selector
  content: Use these story anchors when a behavioral question is visible.
  scope: global
  enabled: true
  curationStatus: curated
  evidenceEntryIds: []
\`\`\`
`,
    },
    1
  );
  const report = auditCuratedMemoryEvidence({ drafts: [draft], now: 2 });

  assert.ok(
    report.issues.some((issue) => issue.code === "template-evidence-empty")
  );
  assert.deepEqual(report.templateReferenceClosure, [
    {
      templateEntryId: "story_template",
      evidenceEntryIds: [],
      anchorEligibleEntryIds: [],
      complete: false,
    },
  ]);
});

test("closes the behavioral selector over fact anchors and golden queries", () => {
  const draft = parseCuratedMemoryDraft(
    {
      path: "behavioral-golden.md",
      content: `
\`\`\`yaml
sources:
  - id: source_profile
    title: Profile
    collection: profiles
    sourceRole: promotion_doc
    scope: global
    curationStatus: curated
\`\`\`

\`\`\`yaml
- id: mem_behavioral_story_selector
  sourceId: source_profile
  type: answer_template
  title: Behavioral interview story selector
  content: Use these story anchors for cost, automation, ambiguity, and customer resource leakage.
  scope: global
  enabled: true
  injectionMode: always
  useCases: [behavioral_interview]
  curationStatus: curated
  evidenceEntryIds: [mem_aos_test_account_cleanup, mem_mlcommons_automated_model_interface, mem_agentic_memory_llm_decisioning, mem_managed_semantic_delete_cleanup]
\`\`\`

\`\`\`yaml
- id: mem_aos_test_account_cleanup
  sourceId: source_profile
  type: personal_story
  title: Inactive test cluster cleanup
  content: Removed more than 400 inactive test resources and saved over 30000 per month.
  summary: Reduced operational waste and recurring cost.
  scope: global
  tags: [cost, waste, cleanup]
  keywords: [inactive test resources, cost savings]
  enabled: true
  useCases: [behavioral_interview]
  curationStatus: curated
\`\`\`

\`\`\`yaml
- id: mem_mlcommons_automated_model_interface
  sourceId: source_profile
  type: answer_evidence
  title: Automated model interface generation
  content: Automated repetitive manual integration setup with generated interfaces.
  scope: global
  tags: [automation, model-interface]
  keywords: [manual model integration, generated interfaces]
  enabled: true
  useCases: [behavioral_interview]
  curationStatus: curated
\`\`\`

\`\`\`yaml
- id: mem_agentic_memory_llm_decisioning
  sourceId: source_profile
  type: answer_evidence
  title: Agentic Memory two-phase decisioning
  content: Resolved architecture ambiguity with separate fact extraction and memory decision phases.
  scope: global
  tags: [agentic-memory, architecture, ambiguity]
  keywords: [two-phase, fact extraction, memory decisioning]
  enabled: true
  useCases: [behavioral_interview]
  curationStatus: curated
\`\`\`

\`\`\`yaml
- id: mem_managed_semantic_delete_cleanup
  sourceId: source_profile
  type: answer_evidence
  title: Semantic search resource cleanup
  content: Prevented customer resource leakage by cleaning up orphaned semantic search pipelines.
  scope: global
  tags: [customer, resource-leakage, cleanup]
  keywords: [orphaned pipelines, semantic search]
  enabled: true
  useCases: [behavioral_interview]
  curationStatus: curated
\`\`\`
`,
    },
    1
  );
  const report = auditCuratedMemoryEvidence({ drafts: [draft], now: 2 });

  assert.equal(report.templateReferenceClosure[0]?.complete, true);
  assert.equal(report.behavioralGoldenQueries.length, 4);
  assert.ok(
    report.behavioralGoldenQueries.every(
      (golden) =>
        golden.expectedAnchorReachable &&
        golden.topRankedAnchorId === golden.expectedAnchorId
    )
  );
  assert.equal(
    report.issues.some(
      (issue) => issue.code === "behavioral-golden-anchor-unreachable"
    ),
    false
  );
});
