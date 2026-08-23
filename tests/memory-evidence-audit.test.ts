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
