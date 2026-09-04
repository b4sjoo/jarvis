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
      content: behavioralGoldenDraft(),
    },
    1
  );
  const report = auditCuratedMemoryEvidence({ drafts: [draft], now: 2 });

  assert.equal(report.schemaVersion, 2);
  assert.equal(report.templateReferenceClosure.length, 6);
  assert.ok(report.templateReferenceClosure.every((item) => item.complete));
  assert.equal(report.behavioralGoldenQueries.length, 12);
  assert.ok(report.behavioralGoldenQueries.every((golden) => golden.correct));
  assert.equal(
    report.issues.some(
      (issue) => issue.code === "behavioral-golden-anchor-unreachable"
    ),
    false
  );
});

function behavioralGoldenDraft() {
  const definitions = [
    {
      family: "mem_behavioral_family_cost_efficiency",
      story: "mem_aos_test_account_cleanup",
      title: "Cost efficiency and operational waste",
      keywords:
        "cost savings waste resources inactive cleanup operational launch release blocker validation limit",
    },
    {
      family: "mem_behavioral_family_conflict_influence",
      story: "mem_agentic_memory_consistency_latency_conflict",
      title: "Conflict influence and technical judgment",
      keywords:
        "conflict disagreement teammate influence decision synchronous consistency asynchronous latency tradeoff",
    },
    {
      family: "mem_behavioral_family_failure_recovery",
      story: "mem_agentic_memory_json_reliability_recovery",
      title: "Failure recovery debugging and learning",
      keywords:
        "failure mistake error unreliable model output invalid json debugging root cause recovery learned",
    },
    {
      family: "mem_behavioral_family_deadline_delivery",
      story: "mem_beaglestone_deadline_delivery_story",
      title: "Deadline prioritization and delivery",
      keywords:
        "deadline deliver pressure language quickly coordinate time zones four weeks project",
    },
    {
      family: "mem_behavioral_family_customer_requirements",
      story: "mem_customer_patch_vfi_story",
      title: "Customer requirements pushback and maintainability",
      keywords:
        "customer unreasonable requirement request pushback customized above beyond maintainable solution long term",
    },
    {
      family: "mem_behavioral_family_trust_people_development",
      story: "mem_new_hire_pavan_development_story",
      title: "Trust feedback and people development",
      keywords:
        "trust mentor mentoring new hire teammate feedback career develop productive team member",
    },
  ];
  const source = `
\`\`\`yaml
sources:
  - id: source_profile
    title: Profile
    collection: profiles
    sourceRole: promotion_doc
    scope: global
    curationStatus: curated
\`\`\`
`;
  return [
    source,
    ...definitions.flatMap((definition) => [
      `
\`\`\`yaml
- id: ${definition.family}
  sourceId: source_profile
  type: answer_template
  title: ${definition.title}
  content: ${definition.keywords}
  scope: global
  tags: [behavioral-story-family, behavioral]
  keywords: [${definition.keywords.split(" ").join(", ")}]
  enabled: true
  injectionMode: retrieval
  useCases: [meeting_assistant, behavioral_interview]
  interviewFamilies: [behavioral]
  curationStatus: curated
  evidenceEntryIds: [${definition.story}]
\`\`\`
`,
      `
\`\`\`yaml
- id: ${definition.story}
  sourceId: source_profile
  type: personal_story
  title: ${definition.title} story
  content: Verified personal story for ${definition.title}.
  scope: global
  tags: [behavioral]
  enabled: true
  injectionMode: retrieval
  useCases: [meeting_assistant, behavioral_interview]
  interviewFamilies: [behavioral]
  curationStatus: curated
\`\`\`
`,
    ]),
  ].join("\n");
}
