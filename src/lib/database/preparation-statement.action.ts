import type {
  InterviewPreparationProfileRevision,
  PreparationCompositionRepository,
  PreparationNarrativeEdge,
  PreparationNarrativeGraph,
  PreparationNarrativeNode,
  PreparationStatement,
  PreparationStatementRepository,
  PreparationStatementReviewEvent,
  PreparationStatementSource,
  PreparationStatementWithSources,
} from "@/lib/preparation/statement-types";
import type { PreparationConversationScope } from "@/lib/preparation/conversation-types";
import { getDatabase } from "./config";

interface StatementRow {
  id: string;
  process_id: string;
  round_id: string | null;
  domain: PreparationStatement["domain"];
  content: string;
  normalized_content: string;
  status: PreparationStatement["status"];
  authority: PreparationStatement["authority"];
  ownership: PreparationStatement["ownership"];
  allowed_wording: string | null;
  prohibited_wording_json: string;
  allowed_interview_families_json: string;
  proposal_operation_id: string;
  source_message_id: string | null;
  supersedes_id: string | null;
  confidence: number | null;
  revision: number;
  last_review_action: PreparationStatement["lastReviewAction"];
  last_review_actor: PreparationStatement["lastReviewActor"];
  created_at: number;
  updated_at: number;
  reviewed_at: number | null;
}

interface StatementSourceRow {
  id: string;
  statement_id: string;
  source_type: PreparationStatementSource["sourceType"];
  source_id: string;
  title: string;
  material_id: string | null;
  material_revision_id: string | null;
  page: number | null;
  section: string | null;
  content_hash: string | null;
  preview: string | null;
  created_at: number;
}

interface StatementEventRow {
  id: string;
  process_id: string;
  statement_id: string;
  statement_revision: number;
  action: PreparationStatementReviewEvent["action"];
  actor: PreparationStatementReviewEvent["actor"];
  previous_status: PreparationStatementReviewEvent["previousStatus"] | null;
  next_status: PreparationStatementReviewEvent["nextStatus"];
  created_at: number;
}

const STATEMENT_SELECT = `
  SELECT s.id, s.process_id, s.round_id, s.domain, s.content,
         s.normalized_content, s.status, s.authority, s.ownership,
         s.allowed_wording, s.prohibited_wording_json,
         s.allowed_interview_families_json, s.proposal_operation_id,
         s.source_message_id, s.supersedes_id, s.confidence, s.revision,
         s.last_review_action, s.last_review_actor, s.created_at,
         s.updated_at, s.reviewed_at
  FROM preparation_statements s
  JOIN preparation_statement_proposal_operations operation
    ON operation.id = s.proposal_operation_id
  WHERE operation.status = 'committed'`;

export const preparationStatementRepository: PreparationStatementRepository = {
  async beginProposalOperation(operation) {
    const db = await getDatabase();
    const key = scopeKey(operation.scope);
    await db.execute(
      `UPDATE preparation_statement_proposal_operations
       SET status = 'stale', settled_at = ?, error = 'Superseded by a newer proposal request.'
       WHERE process_id = ? AND scope_key = ? AND status = 'staging'`,
      [operation.createdAt, operation.processId, key]
    );
    await db.execute(
      `INSERT INTO preparation_statement_proposal_operations
        (id, process_id, scope_kind, scope_key, round_id, conversation_id,
         expected_conversation_revision, provider_id, source_manifest_json,
         source_manifest_hash, status, created_at, settled_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        operation.id,
        operation.processId,
        operation.scope.kind,
        key,
        operation.scope.kind === "round" ? operation.scope.roundId : null,
        operation.conversationId,
        operation.expectedConversationRevision,
        operation.providerId ?? null,
        operation.sourceManifestJson,
        operation.sourceManifestHash,
        operation.status,
        operation.createdAt,
        operation.settledAt ?? null,
        operation.error ?? null,
      ]
    );
  },

  async stageProposalBatch(input) {
    const db = await getDatabase();
    try {
      for (const item of input.statements) {
        const statement = item.statement;
        await db.execute(
          `INSERT INTO preparation_statements
            (id, process_id, round_id, domain, content, normalized_content,
             status, authority, ownership, allowed_wording,
             prohibited_wording_json, allowed_interview_families_json,
             proposal_operation_id, source_message_id, supersedes_id,
             confidence, revision, last_review_action, last_review_actor,
             created_at, updated_at, reviewed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            statement.id,
            statement.processId,
            statement.scope.kind === "round" ? statement.scope.roundId : null,
            statement.domain,
            statement.content,
            statement.normalizedContent,
            statement.status,
            statement.authority,
            statement.ownership,
            statement.allowedWording ?? null,
            JSON.stringify(statement.prohibitedWording),
            JSON.stringify(statement.allowedInterviewFamilies),
            input.operationId,
            statement.sourceMessageId ?? null,
            statement.supersedesId ?? null,
            statement.confidence ?? null,
            statement.revision,
            statement.lastReviewAction,
            statement.lastReviewActor,
            statement.createdAt,
            statement.updatedAt,
            statement.reviewedAt ?? null,
          ]
        );
        for (const source of item.sources) {
          await insertStatementSource(db, source);
        }
      }
    } catch (error) {
      await db.execute(
        "DELETE FROM preparation_statements WHERE proposal_operation_id = ?",
        [input.operationId]
      );
      throw error;
    }
  },

  async commitProposalOperation(input) {
    const db = await getDatabase();
    const updated = await db.execute(
      `UPDATE preparation_statement_proposal_operations AS operation
       SET status = 'committed', settled_at = ?, error = NULL
       WHERE operation.id = ? AND operation.status = 'staging'
         AND EXISTS (
           SELECT 1
           FROM interview_processes process
           JOIN preparation_workspaces workspace ON workspace.id = process.workspace_id
           WHERE process.id = operation.process_id AND workspace.status = 'active'
         )
         AND EXISTS (
           SELECT 1 FROM preparation_conversations conversation
           WHERE conversation.id = operation.conversation_id
             AND conversation.process_id = operation.process_id
             AND conversation.status = 'active'
             AND conversation.revision = operation.expected_conversation_revision
         )
         AND (
           operation.round_id IS NULL OR EXISTS (
             SELECT 1 FROM interview_rounds round
             WHERE round.id = operation.round_id
               AND round.process_id = operation.process_id
               AND round.archived_at IS NULL
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM preparation_statement_proposal_operations newer
           WHERE newer.process_id = operation.process_id
             AND newer.scope_key = operation.scope_key
             AND (
               newer.created_at > operation.created_at OR
               (newer.created_at = operation.created_at AND newer.id > operation.id)
             )
         )`,
      [input.settledAt, input.operationId]
    );
    if (updated.rowsAffected > 0) return true;
    await db.execute(
      `UPDATE preparation_statement_proposal_operations
       SET status = 'stale', settled_at = ?,
           error = COALESCE(error, 'Proposal evidence changed before commit.')
       WHERE id = ? AND status = 'staging'`,
      [input.settledAt, input.operationId]
    );
    return false;
  },

  async settleProposalOperation(input) {
    const db = await getDatabase();
    await db.execute(
      `UPDATE preparation_statement_proposal_operations
       SET status = ?, settled_at = ?, error = ?
       WHERE id = ? AND status = 'staging'`,
      [
        input.status,
        input.settledAt,
        input.error?.slice(0, 1_000) ?? null,
        input.operationId,
      ]
    );
  },

  async list(input) {
    const db = await getDatabase();
    const params: unknown[] = [input.processId];
    const scope = input.roundId
      ? " AND (s.round_id IS NULL OR s.round_id = ?)"
      : " AND s.round_id IS NULL";
    if (input.roundId) params.push(input.roundId);
    const statuses = input.statuses?.length
      ? ` AND s.status IN (${input.statuses.map(() => "?").join(", ")})`
      : "";
    if (input.statuses?.length) params.push(...input.statuses);
    const rows = await db.select<StatementRow[]>(
      `${STATEMENT_SELECT}
       AND s.process_id = ?${scope}${statuses}
       ORDER BY s.updated_at DESC, s.id DESC`,
      params
    );
    return attachSources(rows.map(mapStatement));
  },

  async get(processId, statementId) {
    const db = await getDatabase();
    const rows = await db.select<StatementRow[]>(
      `${STATEMENT_SELECT}
       AND s.process_id = ? AND s.id = ?
       LIMIT 1`,
      [processId, statementId]
    );
    if (!rows[0]) return undefined;
    return (await attachSources([mapStatement(rows[0])]))[0];
  },

  async listEvents(processId, statementId) {
    const db = await getDatabase();
    const rows = await db.select<StatementEventRow[]>(
      `SELECT id, process_id, statement_id, statement_revision, action,
              actor, previous_status, next_status, created_at
       FROM preparation_statement_review_events
       WHERE process_id = ? AND statement_id = ?
       ORDER BY statement_revision ASC`,
      [processId, statementId]
    );
    return rows.map((row) => ({
      id: row.id,
      processId: row.process_id,
      statementId: row.statement_id,
      statementRevision: row.statement_revision,
      action: row.action,
      actor: row.actor,
      previousStatus: row.previous_status ?? undefined,
      nextStatus: row.next_status,
      createdAt: row.created_at,
    }));
  },

  async review(input) {
    const db = await getDatabase();
    const updated = await db.execute(
      `UPDATE preparation_statements AS statement
       SET status = ?, domain = ?, content = ?, normalized_content = ?, ownership = ?,
           allowed_wording = ?, prohibited_wording_json = ?,
           allowed_interview_families_json = ?, authority = ?,
           revision = revision + ?, last_review_action = ?,
           last_review_actor = 'user', updated_at = ?, reviewed_at = ?
       WHERE statement.id = ? AND statement.process_id = ?
         AND statement.revision = ?
         AND EXISTS (
           SELECT 1 FROM preparation_statement_proposal_operations operation
           WHERE operation.id = statement.proposal_operation_id
             AND operation.status = 'committed'
         )
         AND EXISTS (
           SELECT 1
           FROM interview_processes process
           JOIN preparation_workspaces workspace ON workspace.id = process.workspace_id
           WHERE process.id = statement.process_id AND workspace.status = 'active'
         )
         AND (
           statement.round_id IS NULL OR EXISTS (
             SELECT 1 FROM interview_rounds round
             WHERE round.id = statement.round_id
               AND round.process_id = statement.process_id
               AND round.archived_at IS NULL
           )
         )`,
      [
        input.status,
        input.domain,
        input.content,
        input.normalizedContent,
        input.ownership,
        input.allowedWording ?? null,
        JSON.stringify(input.prohibitedWording),
        JSON.stringify(input.allowedInterviewFamilies),
        input.authority,
        input.revisionIncrement,
        input.action,
        input.updatedAt,
        input.updatedAt,
        input.statementId,
        input.processId,
        input.expectedRevision,
      ]
    );
    return updated.rowsAffected > 0;
  },
};

interface ProfileRow {
  id: string;
  process_id: string;
  scope_key: string;
  round_id: string | null;
  revision: number;
  source_fingerprint: string;
  content_hash: string;
  content_json: string;
  confirmed_statement_ids_json: string;
  unresolved_statement_ids_json: string;
  created_at: number;
}

interface NarrativeGraphRow {
  id: string;
  process_id: string;
  scope_key: string;
  round_id: string | null;
  profile_revision_id: string;
  subject_kind: PreparationNarrativeGraph["subjectKind"];
  subject_id: string;
  revision: number;
  source_fingerprint: string;
  status: PreparationNarrativeGraph["status"];
  created_at: number;
  updated_at: number;
}

interface NarrativeNodeRow {
  id: string;
  graph_id: string;
  ordinal: number;
  kind: PreparationNarrativeNode["kind"];
  title: string;
  content_draft: string;
  target_seconds: number | null;
  statement_ids_json: string;
  review_status: PreparationNarrativeNode["reviewStatus"];
  revision: number;
  created_at: number;
  updated_at: number;
}

interface NarrativeEdgeRow {
  id: string;
  graph_id: string;
  from_node_id: string;
  to_node_id: string;
  relation: PreparationNarrativeEdge["relation"];
  created_at: number;
}

const PROFILE_SELECT = `
  SELECT id, process_id, scope_key, round_id, revision, source_fingerprint,
         content_hash, content_json, confirmed_statement_ids_json,
         unresolved_statement_ids_json, created_at
  FROM interview_preparation_profile_revisions
  WHERE build_status = 'committed'`;

export const preparationCompositionRepository: PreparationCompositionRepository = {
  async getProfileByFingerprint(input) {
    const db = await getDatabase();
    const rows = await db.select<ProfileRow[]>(
      `${PROFILE_SELECT}
       AND process_id = ? AND scope_key = ? AND source_fingerprint = ?
       LIMIT 1`,
      [input.processId, scopeKey(input.scope), input.sourceFingerprint]
    );
    return rows[0] ? mapProfile(rows[0]) : undefined;
  },

  async insertProfile(input) {
    const db = await getDatabase();
    const profile = input.profile;
    const inserted = await db.execute(
      `INSERT INTO interview_preparation_profile_revisions
        (id, process_id, scope_key, round_id, revision, source_fingerprint,
         content_hash, content_json, confirmed_statement_ids_json,
         unresolved_statement_ids_json, build_status, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staging', ?
       WHERE EXISTS (
         SELECT 1
         FROM interview_processes process
         JOIN preparation_workspaces workspace ON workspace.id = process.workspace_id
         WHERE process.id = ? AND workspace.status = 'active'
       )
       AND (
         ? IS NULL OR EXISTS (
           SELECT 1 FROM interview_rounds round
           WHERE round.id = ? AND round.process_id = ? AND round.archived_at IS NULL
         )
       )`,
      [
        profile.id,
        profile.processId,
        scopeKey(profile.scope),
        profile.scope.kind === "round" ? profile.scope.roundId : null,
        profile.revision,
        profile.sourceFingerprint,
        profile.contentHash,
        JSON.stringify(profile.content),
        JSON.stringify(profile.confirmedStatementIds),
        JSON.stringify(profile.unresolvedStatementIds),
        profile.createdAt,
        profile.processId,
        profile.scope.kind === "round" ? profile.scope.roundId : null,
        profile.scope.kind === "round" ? profile.scope.roundId : null,
        profile.processId,
      ]
    );
    if (inserted.rowsAffected === 0) {
      throw new Error("Profile scope changed before it could be stored.");
    }
    try {
      for (const [ordinal, link] of input.statementRevisions.entries()) {
        const linked = await db.execute(
          `INSERT INTO preparation_profile_statement_links
            (profile_revision_id, statement_id, statement_revision, ordinal)
           SELECT ?, statement.id, statement.revision, ?
           FROM preparation_statements statement
           JOIN preparation_statement_proposal_operations operation
             ON operation.id = statement.proposal_operation_id
           WHERE statement.id = ? AND statement.process_id = ?
             AND statement.revision = ? AND statement.status = 'confirmed'
             AND operation.status = 'committed'
             AND (
               (? = 'process' AND statement.round_id IS NULL)
               OR
               (? = 'round' AND (statement.round_id IS NULL OR statement.round_id = ?))
             )`,
          [
            profile.id,
            ordinal,
            link.statementId,
            profile.processId,
            link.statementRevision,
            profile.scope.kind,
            profile.scope.kind,
            profile.scope.kind === "round" ? profile.scope.roundId : null,
          ]
        );
        if (linked.rowsAffected === 0) {
          throw new Error("A profile statement changed before composition committed.");
        }
      }
      await db.execute(
        `UPDATE interview_preparation_profile_revisions
         SET build_status = 'committed'
         WHERE id = ? AND build_status = 'staging'`,
        [profile.id]
      );
    } catch (error) {
      await db.execute(
        `DELETE FROM interview_preparation_profile_revisions
         WHERE id = ? AND build_status = 'staging'`,
        [profile.id]
      );
      throw error;
    }
  },

  async getLatestProfile(input) {
    const db = await getDatabase();
    const rows = await db.select<ProfileRow[]>(
      `${PROFILE_SELECT}
       AND process_id = ? AND scope_key = ?
       ORDER BY revision DESC LIMIT 1`,
      [input.processId, scopeKey(input.scope)]
    );
    return rows[0] ? mapProfile(rows[0]) : undefined;
  },

  async listProfiles(input) {
    const db = await getDatabase();
    const rows = await db.select<ProfileRow[]>(
      `${PROFILE_SELECT}
       AND process_id = ? AND scope_key = ?
       ORDER BY revision DESC`,
      [input.processId, scopeKey(input.scope)]
    );
    return rows.map(mapProfile);
  },

  async nextNarrativeRevision(input) {
    const db = await getDatabase();
    const rows = await db.select<Array<{ revision: number }>>(
      `SELECT COALESCE(MAX(revision), 0) + 1 AS revision
       FROM preparation_narrative_graphs
       WHERE process_id = ? AND scope_key = ?
         AND subject_kind = ? AND subject_id = ?`,
      [
        input.processId,
        scopeKey(input.scope),
        input.subjectKind,
        input.subjectId,
      ]
    );
    return rows[0]?.revision ?? 1;
  },

  async insertNarrativeGraph(input) {
    const db = await getDatabase();
    const graph = input.graph;
    const inserted = await db.execute(
      `INSERT INTO preparation_narrative_graphs
        (id, process_id, scope_key, round_id, profile_revision_id,
         subject_kind, subject_id, revision, source_fingerprint, status,
         build_status, created_at, updated_at)
       SELECT ?, ?, ?, ?, profile.id, ?, ?, ?, ?, ?, 'staging', ?, ?
       FROM interview_preparation_profile_revisions profile
       JOIN interview_processes process ON process.id = profile.process_id
       JOIN preparation_workspaces workspace ON workspace.id = process.workspace_id
       WHERE profile.id = ? AND profile.process_id = ?
         AND profile.scope_key = ? AND profile.build_status = 'committed'
         AND workspace.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM interview_preparation_profile_revisions newer
           WHERE newer.process_id = profile.process_id
             AND newer.scope_key = profile.scope_key
             AND newer.build_status = 'committed'
             AND newer.revision > profile.revision
         )`,
      [
        graph.id,
        graph.processId,
        scopeKey(graph.scope),
        graph.scope.kind === "round" ? graph.scope.roundId : null,
        graph.subjectKind,
        graph.subjectId,
        graph.revision,
        graph.sourceFingerprint,
        graph.status,
        graph.createdAt,
        graph.updatedAt,
        graph.profileRevisionId,
        graph.processId,
        scopeKey(graph.scope),
      ]
    );
    if (inserted.rowsAffected === 0) {
      throw new Error("Narrative profile changed before generation committed.");
    }
    try {
      for (const node of graph.nodes) {
        await db.execute(
          `INSERT INTO preparation_narrative_nodes
            (id, graph_id, ordinal, kind, title, content_draft,
             target_seconds, statement_ids_json, review_status, revision,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            node.id,
            graph.id,
            node.ordinal,
            node.kind,
            node.title,
            node.contentDraft,
            node.targetSeconds ?? null,
            JSON.stringify(node.statementIds),
            node.reviewStatus,
            node.revision,
            node.createdAt,
            node.updatedAt,
          ]
        );
        for (const [ordinal, statementId] of node.statementIds.entries()) {
          const statementRevision = input.statementRevisions.get(statementId);
          if (statementRevision === undefined) {
            throw new Error("Narrative node referenced an unbound statement.");
          }
          const linked = await db.execute(
            `INSERT INTO preparation_narrative_node_statement_links
              (node_id, statement_id, statement_revision, ordinal)
             SELECT ?, statement.id, statement.revision, ?
             FROM preparation_statements statement
             JOIN preparation_statement_proposal_operations operation
               ON operation.id = statement.proposal_operation_id
             WHERE statement.id = ? AND statement.process_id = ?
               AND statement.revision = ? AND statement.status = 'confirmed'
               AND operation.status = 'committed'
               AND (
                 (? = 'process' AND statement.round_id IS NULL)
                 OR
                 (? = 'round' AND (statement.round_id IS NULL OR statement.round_id = ?))
               )`,
            [
              node.id,
              ordinal,
              statementId,
              graph.processId,
              statementRevision,
              graph.scope.kind,
              graph.scope.kind,
              graph.scope.kind === "round" ? graph.scope.roundId : null,
            ]
          );
          if (linked.rowsAffected === 0) {
            throw new Error("Narrative evidence changed before commit.");
          }
        }
      }
      for (const edge of graph.edges) {
        await db.execute(
          `INSERT INTO preparation_narrative_edges
            (id, graph_id, from_node_id, to_node_id, relation, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            edge.id,
            graph.id,
            edge.fromNodeId,
            edge.toNodeId,
            edge.relation,
            edge.createdAt,
          ]
        );
      }
      await db.execute(
        `UPDATE preparation_narrative_graphs
         SET build_status = 'committed'
         WHERE id = ? AND build_status = 'staging'`,
        [graph.id]
      );
      await db.execute(
        `UPDATE preparation_narrative_graphs
         SET status = 'superseded', updated_at = ?
         WHERE process_id = ? AND scope_key = ? AND subject_kind = ?
           AND subject_id = ? AND id <> ? AND status = 'current'
           AND build_status = 'committed'`,
        [
          graph.updatedAt,
          graph.processId,
          scopeKey(graph.scope),
          graph.subjectKind,
          graph.subjectId,
          graph.id,
        ]
      );
    } catch (error) {
      await db.execute(
        `UPDATE preparation_narrative_graphs
         SET build_status = 'failed', status = 'stale', updated_at = ?
         WHERE id = ? AND build_status = 'staging'`,
        [graph.updatedAt, graph.id]
      );
      throw error;
    }
  },

  async listNarrativeGraphs(input) {
    const db = await getDatabase();
    const params: unknown[] = [input.processId];
    const scope = input.roundId
      ? " AND (round_id IS NULL OR round_id = ?)"
      : " AND round_id IS NULL";
    if (input.roundId) params.push(input.roundId);
    const rows = await db.select<NarrativeGraphRow[]>(
      `SELECT id, process_id, scope_key, round_id, profile_revision_id,
              subject_kind, subject_id, revision, source_fingerprint,
              status, created_at, updated_at
       FROM preparation_narrative_graphs
       WHERE build_status = 'committed' AND process_id = ?${scope}
       ORDER BY updated_at DESC, id DESC`,
      params
    );
    return attachNarrativeChildren(rows);
  },

  async getNarrativeGraph(processId, graphId) {
    const db = await getDatabase();
    const rows = await db.select<NarrativeGraphRow[]>(
      `SELECT id, process_id, scope_key, round_id, profile_revision_id,
              subject_kind, subject_id, revision, source_fingerprint,
              status, created_at, updated_at
       FROM preparation_narrative_graphs
       WHERE build_status = 'committed' AND process_id = ? AND id = ?
       LIMIT 1`,
      [processId, graphId]
    );
    return rows[0] ? (await attachNarrativeChildren(rows))[0] : undefined;
  },

  async reviewNarrativeNode(input) {
    const db = await getDatabase();
    const updated = await db.execute(
      `UPDATE preparation_narrative_nodes AS node
       SET content_draft = ?, review_status = ?, revision = revision + 1,
           updated_at = ?
       WHERE node.id = ? AND node.revision = ?
         AND (
           ? <> 'confirmed' OR NOT EXISTS (
             SELECT 1
             FROM preparation_narrative_node_statement_links link
             JOIN preparation_statements statement ON statement.id = link.statement_id
             JOIN preparation_statement_proposal_operations operation
               ON operation.id = statement.proposal_operation_id
             WHERE link.node_id = node.id
               AND (
                 statement.status <> 'confirmed'
                 OR statement.revision <> link.statement_revision
                 OR operation.status <> 'committed'
               )
           )
         )
         AND EXISTS (
           SELECT 1
           FROM preparation_narrative_graphs graph
           JOIN interview_processes process ON process.id = graph.process_id
           JOIN preparation_workspaces workspace ON workspace.id = process.workspace_id
           WHERE graph.id = node.graph_id AND graph.process_id = ?
             AND graph.build_status = 'committed'
             AND workspace.status = 'active'
         )`,
      [
        input.contentDraft,
        input.reviewStatus,
        input.updatedAt,
        input.nodeId,
        input.expectedRevision,
        input.reviewStatus,
        input.processId,
      ]
    );
    return updated.rowsAffected > 0;
  },

};

async function insertStatementSource(
  db: Awaited<ReturnType<typeof getDatabase>>,
  source: PreparationStatementSource
) {
  await db.execute(
    `INSERT INTO preparation_statement_sources
      (id, statement_id, source_type, source_id, title, material_id,
       material_revision_id, page, section, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      source.id,
      source.statementId,
      source.sourceType,
      source.sourceId,
      source.title,
      source.materialId ?? null,
      source.materialRevisionId ?? null,
      source.page ?? null,
      source.section ?? null,
      source.contentHash ?? null,
      source.createdAt,
    ]
  );
}

async function attachSources(
  statements: PreparationStatement[]
): Promise<PreparationStatementWithSources[]> {
  if (!statements.length) return [];
  const db = await getDatabase();
  const ids = statements.map((statement) => statement.id);
  const rows = await db.select<StatementSourceRow[]>(
    `SELECT source.id, source.statement_id, source.source_type,
            source.source_id, source.title, source.material_id,
            source.material_revision_id, source.page, source.section,
            source.content_hash, source.created_at,
            CASE source.source_type
              WHEN 'preparation-message' THEN (
                SELECT substr(message.content, 1, 1200)
                FROM preparation_messages message WHERE message.id = source.source_id
              )
              WHEN 'material-chunk' THEN (
                SELECT substr(chunk.content, 1, 1200)
                FROM preparation_material_chunks chunk WHERE chunk.id = source.source_id
              )
              WHEN 'curated-kmb' THEN (
                SELECT substr(entry.content, 1, 1200)
                FROM memory_entries entry WHERE entry.id = source.source_id
              )
              ELSE NULL
            END AS preview
     FROM preparation_statement_sources source
     WHERE statement_id IN (${ids.map(() => "?").join(", ")})
     ORDER BY created_at ASC, id ASC`,
    ids
  );
  const sources = new Map<string, PreparationStatementSource[]>();
  for (const row of rows) {
    const source = mapStatementSource(row);
    sources.set(row.statement_id, [
      ...(sources.get(row.statement_id) ?? []),
      source,
    ]);
  }
  return statements.map((statement) => ({
    ...statement,
    sources: sources.get(statement.id) ?? [],
  }));
}

async function attachNarrativeChildren(
  rows: NarrativeGraphRow[]
): Promise<PreparationNarrativeGraph[]> {
  if (!rows.length) return [];
  const db = await getDatabase();
  const ids = rows.map((row) => row.id);
  const [nodeRows, edgeRows] = await Promise.all([
    db.select<NarrativeNodeRow[]>(
      `SELECT id, graph_id, ordinal, kind, title, content_draft,
              target_seconds, statement_ids_json, review_status, revision,
              created_at, updated_at
       FROM preparation_narrative_nodes
       WHERE graph_id IN (${ids.map(() => "?").join(", ")})
       ORDER BY ordinal ASC, id ASC`,
      ids
    ),
    db.select<NarrativeEdgeRow[]>(
      `SELECT id, graph_id, from_node_id, to_node_id, relation, created_at
       FROM preparation_narrative_edges
       WHERE graph_id IN (${ids.map(() => "?").join(", ")})
       ORDER BY created_at ASC, id ASC`,
      ids
    ),
  ]);
  return rows.map((row) => ({
    ...mapNarrativeGraph(row),
    nodes: nodeRows
      .filter((node) => node.graph_id === row.id)
      .map(mapNarrativeNode),
    edges: edgeRows
      .filter((edge) => edge.graph_id === row.id)
      .map(mapNarrativeEdge),
  }));
}

function mapStatement(row: StatementRow): PreparationStatement {
  return {
    id: row.id,
    processId: row.process_id,
    scope: row.round_id ? { kind: "round", roundId: row.round_id } : { kind: "process" },
    domain: row.domain,
    content: row.content,
    normalizedContent: row.normalized_content,
    status: row.status,
    authority: row.authority,
    ownership: row.ownership,
    allowedWording: row.allowed_wording ?? undefined,
    prohibitedWording: parseStringArray(row.prohibited_wording_json),
    allowedInterviewFamilies: parseStringArray(
      row.allowed_interview_families_json
    ),
    proposalOperationId: row.proposal_operation_id,
    sourceMessageId: row.source_message_id ?? undefined,
    supersedesId: row.supersedes_id ?? undefined,
    confidence: row.confidence ?? undefined,
    revision: row.revision,
    lastReviewAction: row.last_review_action,
    lastReviewActor: row.last_review_actor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at ?? undefined,
  };
}

function mapStatementSource(row: StatementSourceRow): PreparationStatementSource {
  return {
    id: row.id,
    statementId: row.statement_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    title: row.title,
    materialId: row.material_id ?? undefined,
    materialRevisionId: row.material_revision_id ?? undefined,
    page: row.page ?? undefined,
    section: row.section ?? undefined,
    contentHash: row.content_hash ?? undefined,
    preview: row.preview ?? undefined,
    createdAt: row.created_at,
  };
}

function mapProfile(row: ProfileRow): InterviewPreparationProfileRevision {
  return {
    id: row.id,
    processId: row.process_id,
    scope: row.round_id ? { kind: "round", roundId: row.round_id } : { kind: "process" },
    revision: row.revision,
    sourceFingerprint: row.source_fingerprint,
    contentHash: row.content_hash,
    content: JSON.parse(row.content_json),
    confirmedStatementIds: parseStringArray(row.confirmed_statement_ids_json),
    unresolvedStatementIds: parseStringArray(row.unresolved_statement_ids_json),
    createdAt: row.created_at,
  };
}

function mapNarrativeGraph(row: NarrativeGraphRow): Omit<PreparationNarrativeGraph, "nodes" | "edges"> {
  return {
    id: row.id,
    processId: row.process_id,
    scope: row.round_id ? { kind: "round", roundId: row.round_id } : { kind: "process" },
    profileRevisionId: row.profile_revision_id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    revision: row.revision,
    sourceFingerprint: row.source_fingerprint,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapNarrativeNode(row: NarrativeNodeRow): PreparationNarrativeNode {
  return {
    id: row.id,
    graphId: row.graph_id,
    ordinal: row.ordinal,
    kind: row.kind,
    title: row.title,
    contentDraft: row.content_draft,
    targetSeconds: row.target_seconds ?? undefined,
    statementIds: parseStringArray(row.statement_ids_json),
    reviewStatus: row.review_status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapNarrativeEdge(row: NarrativeEdgeRow): PreparationNarrativeEdge {
  return {
    id: row.id,
    graphId: row.graph_id,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    relation: row.relation,
    createdAt: row.created_at,
  };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function scopeKey(scope: PreparationConversationScope) {
  return scope.kind === "process" ? "process" : scope.roundId;
}
