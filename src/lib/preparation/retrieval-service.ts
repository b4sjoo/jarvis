import { retrievalTokens } from "./preparation-context.js";
import type { SqlDatabase } from "./database.js";

export interface CuratedKnowledgeEntry {
  id: string;
  title: string;
  content: string;
  contentHash: string;
  tags: string[];
  allowedCaseTypes?: string[];
}

export interface CaseRetrievalCandidate {
  id: string;
  sourceKind: "material" | "statement" | "kmb";
  content: string;
  label: string;
  score: number;
  contentHash: string;
  materialId?: string;
  materialRevisionHash?: string;
  pageNumber?: number;
  statementId?: string;
}

export function scoreCaseRetrievalCandidate(query: string, candidate: {
  content: string;
  label: string;
  sourceKind: CaseRetrievalCandidate["sourceKind"];
}) {
  const queryTokens = new Set(retrievalTokens(query));
  const labelTokens = retrievalTokens(candidate.label);
  const contentTokens = retrievalTokens(candidate.content);
  const labelScore = labelTokens.reduce((score, token) => score + (queryTokens.has(token) ? 3 : 0), 0);
  const contentScore = contentTokens.reduce((score, token) => score + (queryTokens.has(token) ? 1 : 0), 0);
  const authorityPrior = candidate.sourceKind === "statement" ? 2 : 0;
  return labelScore + contentScore + authorityPrior;
}

export async function retrieveCaseKnowledge(input: {
  database: SqlDatabase;
  caseId: string;
  callPlanId?: string;
  caseType?: string;
  query: string;
  curatedEntries?: CuratedKnowledgeEntry[];
  limit?: number;
}) {
  const materialRows = await input.database.select<Array<{
    id: string;
    material_id: string;
    display_name: string;
    page_number: number | null;
    content: string;
    content_hash: string;
    output_hash: string;
  }>>(
    `SELECT chunk.id, material.id AS material_id, material.display_name, chunk.page_number,
            chunk.content, chunk.content_hash, run.output_hash
     FROM case_materials material
     JOIN extraction_runs run ON run.id = material.selected_extraction_run_id
     JOIN extraction_chunks chunk ON chunk.extraction_run_id = run.id
     WHERE material.case_id = ?
       AND (material.call_plan_id IS NULL OR material.call_plan_id = ?)
       AND (run.status = 'ready' OR (run.status = 'needs-review' AND material.review_status = 'approved'))`,
    [input.caseId, input.callPlanId ?? ""]
  );
  const statementRows = await input.database.select<Array<{
    id: string;
    kind: string;
    content: string;
    revision: number;
  }>>(
    "SELECT id, kind, content, revision FROM case_statements WHERE case_id = ? AND review_state = 'confirmed'",
    [input.caseId]
  );
  const candidates: CaseRetrievalCandidate[] = [
    ...materialRows.map((row) => ({
      id: row.id,
      sourceKind: "material" as const,
      content: row.content,
      label: row.display_name,
      contentHash: row.content_hash,
      materialId: row.material_id,
      materialRevisionHash: row.output_hash,
      pageNumber: row.page_number ?? undefined,
      score: 0,
    })),
    ...statementRows.map((row) => ({
      id: row.id,
      sourceKind: "statement" as const,
      content: row.content,
      label: row.kind,
      contentHash: `${row.id}@${row.revision}`,
      statementId: row.id,
      score: 0,
    })),
    ...(input.curatedEntries ?? [])
      .filter((entry) => !entry.allowedCaseTypes?.length || (input.caseType && entry.allowedCaseTypes.includes(input.caseType)))
      .map((entry) => ({
        id: entry.id,
        sourceKind: "kmb" as const,
        content: entry.content,
        label: `${entry.title} ${entry.tags.join(" ")}`,
        contentHash: entry.contentHash,
        score: 0,
      })),
  ];
  return candidates
    .map((candidate) => ({ ...candidate, score: scoreCaseRetrievalCandidate(input.query, candidate) }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, input.limit ?? 20);
}
