import { sha256 } from "../calling/immutable-snapshot.js";
import type { SqlDatabase } from "./database.js";
import type { PreparationContextManifest } from "./types.js";

interface ContextChunkRow {
  id: string;
  material_id: string;
  display_name: string;
  output_hash: string;
  ordinal: number;
  page_number: number | null;
  content: string;
  content_hash: string;
}

interface ContextStatementRow {
  id: string;
  revision: number;
  kind: string;
  content: string;
  claim_state: string;
  allowed_wording: string | null;
}

interface ContextMessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  revision: number;
}

const stopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "have", "i", "in", "is", "it", "of", "on", "or", "that",
  "the", "this", "to", "was", "we", "what", "with", "you",
]);

export const retrievalTokens = (value: string) =>
  value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !stopWords.has(token));

export function rankPreparationChunks<T extends { content: string; display_name: string }>(
  query: string,
  chunks: T[]
) {
  const queryTokens = new Set(retrievalTokens(query));
  return chunks
    .map((chunk, index) => {
      const contentTokens = retrievalTokens(`${chunk.display_name} ${chunk.content}`);
      const overlap = contentTokens.reduce(
        (score, token) => score + (queryTokens.has(token) ? 1 : 0),
        0
      );
      const phrase = query.trim().toLowerCase();
      const phraseBonus = phrase.length > 8 && chunk.content.toLowerCase().includes(phrase) ? 8 : 0;
      return { chunk, score: overlap + phraseBonus, index };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.chunk);
}

export interface PreparationModelContext {
  identity: {
    caseId: string;
    caseTitle: string;
    callPlanId?: string;
    callPlanTitle?: string;
    objective: string;
  };
  currentRequest: string;
  recentMessages: Array<{ id: string; revision: number; role: "user" | "assistant"; content: string }>;
  rollingSummary?: string;
  confirmedStatements: Array<{
    id: string;
    kind: string;
    claimState: string;
    content: string;
    allowedWording?: string;
  }>;
  materialEvidence: Array<{
    chunkId: string;
    materialId: string;
    materialName: string;
    pageNumber?: number;
    content: string;
  }>;
  unresolvedRisks: string[];
  manifest: PreparationContextManifest;
}

export async function composePreparationContext(input: {
  database: SqlDatabase;
  conversationId: string;
  caseId: string;
  callPlanId?: string;
  currentRequest: string;
  maxChars?: number;
}): Promise<PreparationModelContext> {
  const maxChars = input.maxChars ?? 18_000;
  const cases = await input.database.select<Array<{
    id: string;
    title: string;
    current_revision_id: string | null;
    primary_objective: string;
  }>>(
    `SELECT item.id, item.title, item.current_revision_id, revision.primary_objective
     FROM cases item LEFT JOIN case_revisions revision ON revision.id = item.current_revision_id
     WHERE item.id = ?`,
    [input.caseId]
  );
  if (!cases[0]) throw new Error("Case was not found while composing preparation context.");
  const plans = input.callPlanId
    ? await input.database.select<Array<{ id: string; title: string; objective: string }>>(
        "SELECT id, title, objective FROM call_plans WHERE id = ? AND case_id = ?",
        [input.callPlanId, input.caseId]
      )
    : [];
  if (input.callPlanId && !plans[0]) throw new Error("Call plan belongs to a different case.");
  const conversations = await input.database.select<Array<{ generated_summary: string | null }>>(
    "SELECT generated_summary FROM preparation_conversations WHERE id = ? AND case_id = ?",
    [input.conversationId, input.caseId]
  );
  if (!conversations[0]) throw new Error("Preparation conversation was not found.");

  const messages = await input.database.select<ContextMessageRow[]>(
    `SELECT id, role, content, revision FROM preparation_messages
     WHERE conversation_id = ? AND status = 'committed'
     ORDER BY revision DESC LIMIT 18`,
    [input.conversationId]
  );
  messages.reverse();

  const statements = await input.database.select<ContextStatementRow[]>(
    `SELECT id, revision, kind, content, claim_state, allowed_wording
     FROM case_statements WHERE case_id = ? AND review_state = 'confirmed'
     ORDER BY updated_at DESC LIMIT 60`,
    [input.caseId]
  );

  const chunks = await input.database.select<ContextChunkRow[]>(
    `SELECT chunk.id, material.id AS material_id, material.display_name,
            run.output_hash, chunk.ordinal, chunk.page_number,
            chunk.content, chunk.content_hash
     FROM case_materials material
     JOIN extraction_runs run ON run.id = material.selected_extraction_run_id
     JOIN extraction_chunks chunk ON chunk.extraction_run_id = run.id
     WHERE material.case_id = ?
       AND (material.call_plan_id IS NULL OR material.call_plan_id = ?)
       AND (run.status = 'ready' OR (run.status = 'needs-review' AND material.review_status = 'approved'))
     ORDER BY material.updated_at DESC, chunk.ordinal ASC`,
    [input.caseId, input.callPlanId ?? ""]
  );
  const ranked = rankPreparationChunks(input.currentRequest, chunks);

  let usedChars = input.currentRequest.length;
  const take = <T>(values: T[], size: (value: T) => number, limit: number) => {
    const selected: T[] = [];
    for (const value of values) {
      if (selected.length >= limit || usedChars + size(value) > maxChars) break;
      selected.push(value);
      usedChars += size(value);
    }
    return selected;
  };
  const recentMessages = take(
    [...messages].reverse(),
    (message) => message.content.length,
    12
  ).reverse();
  const confirmed = take(statements, (statement) => statement.content.length, 40);
  const evidence = take(ranked, (chunk) => chunk.content.length, 14);
  const rollingSummary = conversations[0].generated_summary ?? undefined;
  const truncated =
    recentMessages.length < messages.length ||
    confirmed.length < statements.length ||
    evidence.length < chunks.length;
  const manifestBase = {
    caseId: input.caseId,
    callPlanId: input.callPlanId,
    caseRevisionId: cases[0].current_revision_id ?? undefined,
    statementIds: confirmed.map((statement) => statement.id),
    extractionChunkIds: evidence.map((chunk) => chunk.id),
    materialRevisionHashes: [...new Set(evidence.map((chunk) => chunk.output_hash))],
    kmbContentHashes: [] as string[],
    truncated,
  };
  const manifest: PreparationContextManifest = {
    ...manifestBase,
    contextHash: await sha256(JSON.stringify(manifestBase)),
  };
  return {
    identity: {
      caseId: input.caseId,
      caseTitle: cases[0].title,
      callPlanId: input.callPlanId,
      callPlanTitle: plans[0]?.title,
      objective: plans[0]?.objective || cases[0].primary_objective,
    },
    currentRequest: input.currentRequest,
    recentMessages: recentMessages.map((message) => ({ id: message.id, revision: message.revision, role: message.role, content: message.content })),
    rollingSummary,
    confirmedStatements: confirmed.map((statement) => ({
      id: statement.id,
      kind: statement.kind,
      claimState: statement.claim_state,
      content: statement.content,
      allowedWording: statement.allowed_wording ?? undefined,
    })),
    materialEvidence: evidence.map((chunk) => ({
      chunkId: chunk.id,
      materialId: chunk.material_id,
      materialName: chunk.display_name,
      pageNumber: chunk.page_number ?? undefined,
      content: chunk.content,
    })),
    unresolvedRisks: statements
      .filter((statement) => statement.claim_state === "unknown" || statement.kind === "risk")
      .map((statement) => statement.content)
      .slice(0, 12),
    manifest,
  };
}
