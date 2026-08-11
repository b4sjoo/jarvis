import {
  canonicalize,
  getChatProvider,
  loadModelRouteSettings,
  loadProviderSecret,
  requestChatCompletion,
  sha256,
} from "../calling/index.js";
import {
  decodeJson,
  encodeJson,
  loadPreparationDatabase,
  type SqlDatabase,
  withTransaction,
} from "./database.js";
import { retrieveCaseKnowledge, type CuratedKnowledgeEntry } from "./retrieval-service.js";
import type {
  CallPlan,
  CallPlaybookSnapshot,
  CallPreparationSnapshotBundle,
  CaseSourceRef,
  CaseStatement,
  EvidenceIndexEntry,
  SnapshotArtifactRef,
  SnapshotSourceManifest,
  SnapshotWarning,
  SpeechBiasTerm,
} from "./types.js";

export const SNAPSHOT_COMPILER_VERSION = "moss-call-preparation-v1";
const STAGE_IDS: CallPlaybookSnapshot["stages"][number]["id"][] = [
  "orient", "establish", "request", "resolve", "confirm-close",
];

const SNAPSHOT_SYSTEM_PROMPT = `You generate only a bounded call playbook and speech-recognition bias proposals for MOSS.
Return JSON only:
{"playbook":{"stages":[{"id":"orient|establish|request|resolve|confirm-close","goal":"...","prompts":["..."],"exitSignals":["..."]}],"fallbackMoves":["..."]},"speechBiasTerms":[{"term":"...","aliases":["..."]}]}
Include each stage exactly once in the supplied order. Keep the playbook concise and conditional. Do not add facts, legal conclusions, commitments, or evidence. Speech-bias terms must appear verbatim in the supplied confirmed state, party names, plan, or evidence excerpts. Speech bias improves transcription only and grants no fact authority.`;

interface SnapshotRow {
  id: string;
  compile_id: string;
  case_id: string;
  case_revision_id: string;
  call_plan_id: string;
  version: number;
  state: CallPreparationSnapshotBundle["state"];
  bundle_json: string;
  source_manifest_json: string;
  artifact_manifest_json: string;
  warnings_json: string;
  content_hash: string;
  compiler_version: string;
  compiled_at: number;
}

interface FrozenStatement {
  statement: CaseStatement;
  contentHash: string;
}

interface FrozenSourceSet {
  caseId: string;
  caseType?: string;
  caseRevision: {
    id: string;
    revision: number;
    primaryObjective: string;
    acceptableFallbacks: string[];
    partyIds: string[];
    statementIds: string[];
    nextActionIds: string[];
  };
  callPlan: CallPlan;
  parties: Array<{ id: string; displayName: string; organization?: string; sourceRefs: CaseSourceRef[] }>;
  statements: FrozenStatement[];
  extractionRuns: SnapshotSourceManifest["extractionRuns"];
  evidence: EvidenceIndexEntry[];
  curatedEntries: CuratedKnowledgeEntry[];
  manifest: SnapshotSourceManifest;
  warnings: SnapshotWarning[];
}

export interface SnapshotModelProposal {
  playbook: CallPlaybookSnapshot;
  speechBiasTerms: Array<{ term: string; aliases: string[] }>;
}

export interface CuratedKnowledgeProvider {
  getEntries(ids: string[]): Promise<CuratedKnowledgeEntry[]>;
}

const genericStage = (id: CallPlaybookSnapshot["stages"][number]["id"]): CallPlaybookSnapshot["stages"][number] => ({
  id,
  goal: ({
    orient: "Confirm who is present and the purpose of the call.",
    establish: "Establish the relevant facts, constraints, and unresolved points.",
    request: "State the requested outcome and a supported fallback.",
    resolve: "Address objections, conditions, and missing evidence.",
    "confirm-close": "Confirm commitments, dates, reference numbers, and next actions.",
  })[id],
  prompts: [],
  exitSignals: [],
});

const cleanJson = (value: string) => value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
const strings = (value: unknown) => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
  : [];

export function parseSnapshotModelProposal(value: string): SnapshotModelProposal {
  const parsed = JSON.parse(cleanJson(value)) as Record<string, unknown>;
  const playbook = parsed.playbook && typeof parsed.playbook === "object"
    ? parsed.playbook as Record<string, unknown>
    : {};
  const rawStages = Array.isArray(playbook.stages) ? playbook.stages : [];
  const stages = STAGE_IDS.map((id) => {
    const raw = rawStages.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).id === id) as Record<string, unknown> | undefined;
    if (!raw) return genericStage(id);
    return {
      id,
      goal: typeof raw.goal === "string" && raw.goal.trim() ? raw.goal.trim() : genericStage(id).goal,
      prompts: strings(raw.prompts).slice(0, 5),
      exitSignals: strings(raw.exitSignals).slice(0, 5),
    };
  });
  const speechBiasTerms = (Array.isArray(parsed.speechBiasTerms) ? parsed.speechBiasTerms : [])
    .flatMap((item) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const term = typeof record.term === "string" ? record.term.trim() : "";
      return term ? [{ term, aliases: strings(record.aliases).slice(0, 8) }] : [];
    });
  return {
    playbook: { stages, fallbackMoves: strings(playbook.fallbackMoves).slice(0, 8) },
    speechBiasTerms,
  };
}

const mapSnapshot = (row: SnapshotRow): CallPreparationSnapshotBundle => {
  const bundle = decodeJson<CallPreparationSnapshotBundle>(row.bundle_json, {} as CallPreparationSnapshotBundle);
  return {
    ...bundle,
    id: row.id,
    compileId: row.compile_id,
    caseId: row.case_id,
    caseRevisionId: row.case_revision_id,
    callPlanId: row.call_plan_id,
    version: row.version,
    state: row.state,
    sourceManifest: decodeJson(row.source_manifest_json, bundle.sourceManifest),
    artifactManifest: decodeJson(row.artifact_manifest_json, bundle.artifactManifest),
    warnings: decodeJson(row.warnings_json, bundle.warnings),
    contentHash: row.content_hash,
    compilerVersion: row.compiler_version,
    compiledAt: row.compiled_at,
  };
};

export async function snapshotBundleHash(bundleContent: unknown) {
  return sha256(canonicalize(bundleContent));
}

export function diffSnapshotBundles(current: CallPreparationSnapshotBundle, previous?: CallPreparationSnapshotBundle) {
  if (!previous) return ["Initial snapshot"];
  const sections: Array<keyof Pick<CallPreparationSnapshotBundle,
    "caseSnapshot" | "callBrief" | "playbookSnapshot" | "speechBiasTerms" | "evidenceIndex" | "safetyConstraints">> = [
      "caseSnapshot", "callBrief", "playbookSnapshot", "speechBiasTerms", "evidenceIndex", "safetyConstraints",
    ];
  return sections.filter((section) => canonicalize(current[section]) !== canonicalize(previous[section]));
}

export class CallPreparationSnapshotService {
  constructor(
    private readonly database: SqlDatabase,
    private readonly curatedKnowledgeProvider?: CuratedKnowledgeProvider
  ) {}

  static async open(curatedKnowledgeProvider?: CuratedKnowledgeProvider) {
    return new CallPreparationSnapshotService(await loadPreparationDatabase(), curatedKnowledgeProvider);
  }

  async list(caseId: string, callPlanId?: string) {
    const rows = callPlanId
      ? await this.database.select<SnapshotRow[]>("SELECT * FROM call_preparation_snapshots WHERE case_id = ? AND call_plan_id = ? ORDER BY version DESC", [caseId, callPlanId])
      : await this.database.select<SnapshotRow[]>("SELECT * FROM call_preparation_snapshots WHERE case_id = ? ORDER BY compiled_at DESC", [caseId]);
    return rows.map(mapSnapshot);
  }

  async get(snapshotId: string) {
    const rows = await this.database.select<SnapshotRow[]>("SELECT * FROM call_preparation_snapshots WHERE id = ?", [snapshotId]);
    return rows[0] ? mapSnapshot(rows[0]) : null;
  }

  async compileDraft(input: { caseId: string; callPlanId: string; curatedEntries?: CuratedKnowledgeEntry[] }) {
    const compileId = `snapshot_compile_${crypto.randomUUID()}`;
    const frozen = await this.freezeSources(input.caseId, input.callPlanId, input.curatedEntries ?? []);
    await this.recordOperation(input.caseId, input.callPlanId, compileId, "snapshot-source-freeze", "committed", frozen.manifest);
    const route = loadModelRouteSettings().chat.complex;
    const provider = getChatProvider(route.provider);
    const apiKey = provider.requiresApiKey ? await loadProviderSecret("complex") : "";
    if (provider.requiresApiKey && !apiKey) throw new Error("Configure the Complex Task model before compiling a call snapshot.");
    const modelInput = {
      caseObjective: frozen.caseRevision.primaryObjective,
      acceptableFallbacks: frozen.caseRevision.acceptableFallbacks,
      callPlan: {
        objective: frozen.callPlan.objective,
        outcomes: frozen.callPlan.acceptableOutcomes,
        questions: frozen.callPlan.questionsToAsk,
        risks: frozen.callPlan.knownRisks,
      },
      parties: frozen.parties.map((party) => party.displayName),
      confirmedStatements: frozen.statements.map(({ statement }) => ({ id: statement.id, kind: statement.kind, content: statement.content })),
      evidence: frozen.evidence.map((item) => ({ evidenceId: item.evidenceId, label: item.label, excerpt: item.excerpt })),
    };
    await this.recordOperation(input.caseId, input.callPlanId, compileId, "snapshot-model-proposal", "dispatched", { provider: route.provider, model: route.model });
    let proposal: SnapshotModelProposal;
    try {
      const response = await requestChatCompletion({
        route,
        apiKey,
        messages: [
          { role: "system", content: SNAPSHOT_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(modelInput) },
        ],
      });
      proposal = parseSnapshotModelProposal(response);
    } catch (error) {
      await this.recordOperation(input.caseId, input.callPlanId, compileId, "snapshot-model-proposal", "failed", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const { speechBiasTerms, warnings: groundingWarnings } = this.groundSpeechBias(proposal.speechBiasTerms, frozen);
    const warnings = [...frozen.warnings, ...groundingWarnings];
    const previous = (await this.list(input.caseId, input.callPlanId))[0];
    const version = (previous?.version ?? 0) + 1;
    const compiledAt = Date.now();
    const id = `call_snapshot_${crypto.randomUUID()}`;
    const caseSnapshot = {
      objective: frozen.caseRevision.primaryObjective,
      acceptableFallbacks: frozen.caseRevision.acceptableFallbacks,
      supportedStatements: frozen.statements.filter(({ statement }) => statement.claimState === "supported" || statement.claimState === "asserted").map(({ statement }) => ({ statementId: statement.id, kind: statement.kind, content: statement.content, allowedWording: statement.allowedWording })),
      disputedClaims: frozen.statements.filter(({ statement }) => statement.claimState === "disputed").map(({ statement }) => ({ statementId: statement.id, content: statement.content })),
      unknowns: frozen.statements.filter(({ statement }) => statement.claimState === "unknown" || statement.kind === "unknown").map(({ statement }) => ({ statementId: statement.id, content: statement.content })),
      commitments: frozen.statements.filter(({ statement }) => statement.kind === "commitment").map(({ statement }) => ({ statementId: statement.id, content: statement.content })),
      deadlines: frozen.statements.filter(({ statement }) => statement.kind === "deadline").map(({ statement }) => ({ statementId: statement.id, content: statement.content })),
      nextActions: frozen.statements.filter(({ statement }) => statement.kind === "action").map(({ statement }) => ({ statementId: statement.id, content: statement.content })),
    };
    const callBrief = {
      objective: frozen.callPlan.objective,
      counterpartyNames: frozen.parties.filter((party) => frozen.callPlan.counterpartyIds.includes(party.id)).map((party) => party.displayName),
      acceptableOutcomes: frozen.callPlan.acceptableOutcomes,
      questionsToAsk: frozen.callPlan.questionsToAsk,
      knownRisks: frozen.callPlan.knownRisks,
      scheduledAt: frozen.callPlan.scheduledAt,
    };
    const safetyConstraints = {
      prohibitedClaims: frozen.statements.filter(({ statement }) => statement.reviewState !== "confirmed").map(({ statement }) => statement.content),
      uncertainClaims: frozen.statements.filter(({ statement }) => ["unknown", "disputed", "stale"].includes(statement.claimState)).map(({ statement }) => statement.content),
      missingJurisdictions: frozen.statements.filter(({ statement }) => ["commitment", "deadline"].includes(statement.kind) && !statement.jurisdiction).map(({ statement }) => statement.content),
      requiredAttribution: frozen.statements.filter(({ statement }) => statement.kind === "claim" && Boolean(statement.speakerPartyId)).map(({ statement }) => statement.content),
    };
    const artifactInputs = {
      caseSnapshot,
      callBrief,
      playbookSnapshot: proposal.playbook,
      speechBiasTerms,
      evidenceIndex: frozen.evidence,
      safetyConstraints,
    };
    const artifactManifest = await this.buildArtifactManifest(id, artifactInputs, frozen);
    const hashInput = {
      id,
      compileId,
      caseId: input.caseId,
      caseRevisionId: frozen.caseRevision.id,
      callPlanId: input.callPlanId,
      version,
      ...artifactInputs,
      artifactManifest,
      sourceManifest: frozen.manifest,
      warnings,
      compilerVersion: SNAPSHOT_COMPILER_VERSION,
      compiledAt,
    };
    const contentHash = await snapshotBundleHash({
      caseId: input.caseId,
      caseRevisionId: frozen.caseRevision.id,
      callPlanId: input.callPlanId,
      ...artifactInputs,
      sourceManifest: frozen.manifest,
      warnings,
      compilerVersion: SNAPSHOT_COMPILER_VERSION,
    });
    const existing = await this.database.select<SnapshotRow[]>(
      "SELECT * FROM call_preparation_snapshots WHERE case_id = ? AND call_plan_id = ? AND content_hash = ?",
      [input.caseId, input.callPlanId, contentHash]
    );
    if (existing[0]) return mapSnapshot(existing[0]);
    const bundle: CallPreparationSnapshotBundle = { ...hashInput, state: "draft", contentHash };
    await withTransaction(this.database, async (transaction) => {
      await transaction.execute(
        `INSERT INTO call_preparation_snapshots (
          id, compile_id, case_id, case_revision_id, call_plan_id, version, state,
          bundle_json, source_manifest_json, artifact_manifest_json, warnings_json,
          content_hash, compiler_version, compiled_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, compileId, input.caseId, frozen.caseRevision.id, input.callPlanId, version, encodeJson(bundle), encodeJson(frozen.manifest), encodeJson(artifactManifest), encodeJson(warnings), contentHash, SNAPSHOT_COMPILER_VERSION, compiledAt, compiledAt]
      );
      for (const artifact of artifactManifest) {
        await transaction.execute(
          `INSERT INTO snapshot_artifacts (
            id, snapshot_id, lineage_key, artifact_path, section, content_hash, source_refs_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [artifact.artifactId, id, artifact.lineageKey, artifact.artifactPath, artifact.section, artifact.contentHash, encodeJson(artifact.sourceRefs), compiledAt]
        );
      }
    });
    await this.recordOperation(input.caseId, input.callPlanId, compileId, "snapshot-model-proposal", "committed", { snapshotId: id, warningCount: warnings.length });
    return bundle;
  }

  async markReady(snapshotId: string) {
    const snapshot = await this.get(snapshotId);
    if (!snapshot) throw new Error("Snapshot was not found.");
    if (snapshot.state !== "draft") throw new Error("Only a draft snapshot can become ready.");
    if (snapshot.warnings.some((warning) => warning.severity === "error")) {
      throw new Error("Resolve snapshot errors before marking it ready.");
    }
    await withTransaction(this.database, async (transaction) => {
      await this.revalidateManifest(snapshot.caseId, snapshot.sourceManifest, transaction);
      await transaction.execute(
        "UPDATE call_preparation_snapshots SET state = 'superseded', updated_at = ? WHERE case_id = ? AND call_plan_id = ? AND state = 'ready'",
        [Date.now(), snapshot.caseId, snapshot.callPlanId]
      );
      const changed = await transaction.execute(
        "UPDATE call_preparation_snapshots SET state = 'ready', updated_at = ? WHERE id = ? AND state = 'draft'",
        [Date.now(), snapshot.id]
      );
      if (changed.rowsAffected !== 1) throw new Error("Snapshot state changed before Ready commit.");
    });
    await this.recordOperation(snapshot.caseId, snapshot.callPlanId, snapshot.compileId, "snapshot-ready", "committed", { snapshotId });
    return this.get(snapshotId);
  }

  async invalidate(snapshotId: string, reason: string) {
    const snapshot = await this.get(snapshotId);
    if (!snapshot) throw new Error("Snapshot was not found.");
    if (snapshot.state === "invalidated") return snapshot;
    const changed = await this.database.execute(
      `UPDATE call_preparation_snapshots SET state = 'invalidated', invalidation_reason = ?,
       updated_at = ? WHERE id = ? AND state != 'invalidated'`,
      [reason.trim() || "invalidated-by-user", Date.now(), snapshotId]
    );
    if (changed.rowsAffected !== 1) throw new Error("Snapshot invalidation conflict.");
    return this.get(snapshotId);
  }

  private async freezeSources(caseId: string, callPlanId: string, curatedEntries: CuratedKnowledgeEntry[]): Promise<FrozenSourceSet> {
    const cases = await this.database.select<Array<{ id: string; case_type: string | null; current_revision_id: string }>>(
      "SELECT id, case_type, current_revision_id FROM cases WHERE id = ?",
      [caseId]
    );
    if (!cases[0]) throw new Error("Case was not found.");
    const revisionRows = await this.database.select<Array<{
      id: string; revision: number; primary_objective: string; acceptable_fallbacks_json: string;
      party_ids_json: string; statement_ids_json: string; next_action_ids_json: string;
    }>>("SELECT * FROM case_revisions WHERE id = ? AND case_id = ?", [cases[0].current_revision_id, caseId]);
    if (!revisionRows[0]) throw new Error("Current CaseRevision was not found.");
    const planRows = await this.database.select<Array<{
      id: string; case_id: string; title: string; state: CallPlan["state"]; objective: string;
      counterparty_ids_json: string; acceptable_outcomes_json: string; questions_to_ask_json: string;
      known_risks_json: string; scheduled_at: number | null; row_revision: number; created_at: number; updated_at: number;
    }>>("SELECT * FROM call_plans WHERE id = ? AND case_id = ?", [callPlanId, caseId]);
    if (!planRows[0]) throw new Error("CallPlan belongs to a different Case.");
    const planRow = planRows[0];
    const callPlan: CallPlan = {
      id: planRow.id, caseId: planRow.case_id, title: planRow.title, state: planRow.state,
      objective: planRow.objective, counterpartyIds: decodeJson(planRow.counterparty_ids_json, []),
      acceptableOutcomes: decodeJson(planRow.acceptable_outcomes_json, []), questionsToAsk: decodeJson(planRow.questions_to_ask_json, []),
      knownRisks: decodeJson(planRow.known_risks_json, []), scheduledAt: planRow.scheduled_at ?? undefined,
      rowRevision: planRow.row_revision, createdAt: planRow.created_at, updatedAt: planRow.updated_at,
    };
    const revisionRow = revisionRows[0];
    const statementIds = decodeJson<string[]>(revisionRow.statement_ids_json, []);
    const statementRows = statementIds.length ? await this.database.select<Array<{
      id: string; case_id: string; revision: number; kind: CaseStatement["kind"]; content: string;
      subject_party_id: string | null; speaker_party_id: string | null; review_state: CaseStatement["reviewState"];
      claim_state: CaseStatement["claimState"]; jurisdiction: string | null; valid_from: number | null;
      valid_until: number | null; allowed_uses_json: string; allowed_wording: string | null;
      supersedes_id: string | null; created_by: CaseStatement["createdBy"]; created_at: number; updated_at: number;
    }>>(`SELECT * FROM case_statements WHERE case_id = ? AND id IN (${statementIds.map(() => "?").join(",")}) AND review_state = 'confirmed' ORDER BY id`, [caseId, ...statementIds]) : [];
    const sourceRows = statementIds.length ? await this.database.select<Array<{
      id: string; statement_id: string; source_kind: CaseSourceRef["sourceKind"]; source_id: string;
      source_revision: number | null; content_hash: string; page_number: number | null; quoted_text: string | null;
    }>>(`SELECT source.* FROM case_statement_sources source JOIN case_statements statement ON statement.id = source.statement_id WHERE statement.case_id = ? AND statement.id IN (${statementIds.map(() => "?").join(",")}) ORDER BY source.created_at`, [caseId, ...statementIds]) : [];
    const statements: FrozenStatement[] = [];
    for (const row of statementRows) {
      const sources = sourceRows.filter((source) => source.statement_id === row.id).map((source) => ({
        id: source.id, sourceKind: source.source_kind, sourceId: source.source_id,
        sourceRevision: source.source_revision ?? undefined, contentHash: source.content_hash,
        pageNumber: source.page_number ?? undefined, quotedText: source.quoted_text ?? undefined,
      }));
      const statement: CaseStatement = {
        id: row.id, caseId: row.case_id, revision: row.revision, kind: row.kind, content: row.content,
        subjectPartyId: row.subject_party_id ?? undefined, speakerPartyId: row.speaker_party_id ?? undefined,
        sourceRefs: sources, reviewState: row.review_state, claimState: row.claim_state,
        jurisdiction: row.jurisdiction ?? undefined, validFrom: row.valid_from ?? undefined,
        validUntil: row.valid_until ?? undefined, allowedUses: decodeJson(row.allowed_uses_json, []),
        allowedWording: row.allowed_wording ?? undefined, supersedesId: row.supersedes_id ?? undefined,
        createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
      };
      statements.push({ statement, contentHash: await sha256(canonicalize({ content: statement.content, sources: statement.sourceRefs, revision: statement.revision })) });
    }
    const partyIds = decodeJson<string[]>(revisionRow.party_ids_json, []);
    const partyRows = partyIds.length ? await this.database.select<Array<{ id: string; display_name: string; organization: string | null; source_refs_json: string }>>(
      `SELECT id, display_name, organization, source_refs_json FROM case_parties WHERE case_id = ? AND id IN (${partyIds.map(() => "?").join(",")}) AND review_state = 'confirmed'`,
      [caseId, ...partyIds]
    ) : [];
    const extractionRows = await this.database.select<Array<{ material_id: string; run_id: string; output_hash: string }>>(
      `SELECT material.id AS material_id, run.id AS run_id, run.output_hash
       FROM case_materials material JOIN extraction_runs run ON run.id = material.selected_extraction_run_id
       WHERE material.case_id = ? AND (material.call_plan_id IS NULL OR material.call_plan_id = ?)
       AND (run.status = 'ready' OR (run.status = 'needs-review' AND material.review_status = 'approved'))
       ORDER BY material.id`,
      [caseId, callPlanId]
    );
    const retrieved = await retrieveCaseKnowledge({ database: this.database, caseId, callPlanId, caseType: cases[0].case_type ?? undefined, query: `${callPlan.objective} ${callPlan.questionsToAsk.join(" ")}`, curatedEntries, limit: 24 });
    const evidence: EvidenceIndexEntry[] = [];
    for (const candidate of retrieved.filter((item) => item.sourceKind !== "statement").slice(0, 16)) {
      const sourceRef: CaseSourceRef = {
        id: `snapshot_source_${candidate.sourceKind}_${candidate.id}`,
        sourceKind: candidate.sourceKind === "kmb" ? "kmb" : "material",
        sourceId: candidate.id,
        contentHash: candidate.contentHash,
        pageNumber: candidate.pageNumber,
        quotedText: candidate.content.slice(0, 700),
      };
      evidence.push({
        evidenceId: `evidence_${candidate.sourceKind}_${candidate.id}`,
        label: candidate.label,
        excerpt: candidate.content.slice(0, 700),
        allowedUses: ["call-preparation", "advisor-grounding"],
        sourceRefs: [sourceRef],
      });
    }
    for (const item of statements.filter(({ statement }) => statement.sourceRefs.length)) {
      evidence.push({ evidenceId: `evidence_statement_${item.statement.id}`, label: item.statement.kind, excerpt: item.statement.content, allowedUses: item.statement.allowedUses, sourceRefs: item.statement.sourceRefs });
    }
    const manifest: SnapshotSourceManifest = {
      caseRevisionId: revisionRow.id,
      caseRevisionNumber: revisionRow.revision,
      callPlanId,
      callPlanRevision: callPlan.rowRevision,
      extractionRuns: extractionRows.map((row) => ({ materialId: row.material_id, extractionRunId: row.run_id, outputHash: row.output_hash })),
      statements: statements.map((item) => ({ statementId: item.statement.id, revision: item.statement.revision, contentHash: item.contentHash })),
      kmbEntries: curatedEntries.map((entry) => ({ id: entry.id, contentHash: entry.contentHash })),
      modelRoute: `${loadModelRouteSettings().chat.complex.provider}:${loadModelRouteSettings().chat.complex.model}`,
      compilerVersion: SNAPSHOT_COMPILER_VERSION,
    };
    const warnings: SnapshotWarning[] = [];
    if (!statements.length) warnings.push({ code: "no-confirmed-statements", severity: "warning", message: "The snapshot has no confirmed Case Statements.", sourceRefs: [] });
    if (!partyRows.length) warnings.push({ code: "no-confirmed-party", severity: "warning", message: "No confirmed party is available for the call.", sourceRefs: [] });
    if (!callPlan.questionsToAsk.length) warnings.push({ code: "no-planned-questions", severity: "info", message: "The CallPlan has no explicit questions to ask.", sourceRefs: [] });
    return {
      caseId,
      caseType: cases[0].case_type ?? undefined,
      caseRevision: { id: revisionRow.id, revision: revisionRow.revision, primaryObjective: revisionRow.primary_objective, acceptableFallbacks: decodeJson(revisionRow.acceptable_fallbacks_json, []), partyIds, statementIds, nextActionIds: decodeJson(revisionRow.next_action_ids_json, []) },
      callPlan,
      parties: partyRows.map((party) => ({ id: party.id, displayName: party.display_name, organization: party.organization ?? undefined, sourceRefs: decodeJson(party.source_refs_json, []) })),
      statements,
      extractionRuns: manifest.extractionRuns,
      evidence,
      curatedEntries,
      manifest,
      warnings,
    };
  }

  private groundSpeechBias(proposals: SnapshotModelProposal["speechBiasTerms"], frozen: FrozenSourceSet) {
    const sourceText = [
      frozen.caseRevision.primaryObjective,
      frozen.callPlan.title,
      frozen.callPlan.objective,
      ...frozen.parties.flatMap((party) => [party.displayName, party.organization ?? ""]),
      ...frozen.statements.map((item) => item.statement.content),
      ...frozen.evidence.map((item) => item.excerpt),
    ].join("\n");
    const warnings: SnapshotWarning[] = [];
    const speechBiasTerms: SpeechBiasTerm[] = [];
    for (const proposal of proposals) {
      if (!sourceText.toLocaleLowerCase().includes(proposal.term.toLocaleLowerCase())) {
        warnings.push({ code: "ungrounded-speech-bias", severity: "warning", message: `Speech-bias term '${proposal.term}' was omitted because no frozen source contains it.`, sourceRefs: [] });
        continue;
      }
      const sourceRefs = frozen.evidence.flatMap((item) => item.sourceRefs).filter((source) => source.quotedText?.toLocaleLowerCase().includes(proposal.term.toLocaleLowerCase()));
      speechBiasTerms.push({ term: proposal.term, aliases: proposal.aliases, sourceRefs });
    }
    return { speechBiasTerms, warnings };
  }

  private async buildArtifactManifest(snapshotId: string, sections: Record<string, unknown>, frozen: FrozenSourceSet) {
    const allSources = frozen.evidence.flatMap((item) => item.sourceRefs);
    const entries = Object.entries(sections);
    const artifacts: SnapshotArtifactRef[] = [];
    for (const [section, content] of entries) {
      const contentHash = await sha256(canonicalize(content));
      artifacts.push({
        artifactId: `snapshot_artifact_${crypto.randomUUID()}`,
        lineageKey: `${frozen.callPlan.id}:${section}`,
        artifactPath: `${snapshotId}/${section}`,
        section,
        contentHash,
        sourceRefs: section === "playbookSnapshot" ? [] : allSources,
      });
    }
    return artifacts;
  }

  private async revalidateManifest(
    caseId: string,
    manifest: SnapshotSourceManifest,
    database: SqlDatabase = this.database
  ) {
    const caseRows = await database.select<Array<{ current_revision_id: string }>>("SELECT current_revision_id FROM cases WHERE id = ?", [caseId]);
    if (caseRows[0]?.current_revision_id !== manifest.caseRevisionId) throw new Error("CaseRevision changed after snapshot source freeze.");
    const planRows = await database.select<Array<{ row_revision: number }>>("SELECT row_revision FROM call_plans WHERE id = ? AND case_id = ?", [manifest.callPlanId, caseId]);
    if (planRows[0]?.row_revision !== manifest.callPlanRevision) throw new Error("CallPlan changed after snapshot source freeze.");
    const currentExtractionRows = await database.select<Array<{ material_id: string; run_id: string; output_hash: string }>>(
      `SELECT material.id AS material_id, run.id AS run_id, run.output_hash
       FROM case_materials material JOIN extraction_runs run ON run.id = material.selected_extraction_run_id
       WHERE material.case_id = ? AND (material.call_plan_id IS NULL OR material.call_plan_id = ?)
       AND (run.status = 'ready' OR (run.status = 'needs-review' AND material.review_status = 'approved'))
       ORDER BY material.id`,
      [caseId, manifest.callPlanId]
    );
    const currentExtractionSet = currentExtractionRows.map((row) => ({ materialId: row.material_id, extractionRunId: row.run_id, outputHash: row.output_hash }));
    if (canonicalize(currentExtractionSet) !== canonicalize(manifest.extractionRuns)) {
      throw new Error("The eligible ExtractionRun source set changed after snapshot source freeze.");
    }
    for (const expected of manifest.extractionRuns) {
      const rows = await database.select<Array<{ selected_extraction_run_id: string; output_hash: string; status: string; review_status: string }>>(
        `SELECT material.selected_extraction_run_id, run.output_hash, run.status, material.review_status
         FROM case_materials material JOIN extraction_runs run ON run.id = material.selected_extraction_run_id
         WHERE material.id = ? AND material.case_id = ?`,
        [expected.materialId, caseId]
      );
      const current = rows[0];
      const eligible = current && (current.status === "ready" || (current.status === "needs-review" && current.review_status === "approved"));
      if (!eligible || current.selected_extraction_run_id !== expected.extractionRunId || current.output_hash !== expected.outputHash) {
        throw new Error("A selected ExtractionRun changed after snapshot source freeze.");
      }
    }
    for (const expected of manifest.statements) {
      const rows = await database.select<Array<{ revision: number; content: string; review_state: string }>>("SELECT revision, content, review_state FROM case_statements WHERE id = ? AND case_id = ?", [expected.statementId, caseId]);
      const current = rows[0];
      if (!current || current.review_state !== "confirmed" || current.revision !== expected.revision) throw new Error("A confirmed statement changed after snapshot source freeze.");
      const sourceRows = await database.select<Array<{ id: string; source_kind: string; source_id: string; source_revision: number | null; content_hash: string; page_number: number | null; quoted_text: string | null }>>("SELECT * FROM case_statement_sources WHERE statement_id = ? ORDER BY created_at", [expected.statementId]);
      const contentHash = await sha256(canonicalize({ content: current.content, sources: sourceRows.map((source) => ({ id: source.id, sourceKind: source.source_kind, sourceId: source.source_id, sourceRevision: source.source_revision ?? undefined, contentHash: source.content_hash, pageNumber: source.page_number ?? undefined, quotedText: source.quoted_text ?? undefined })), revision: current.revision }));
      if (contentHash !== expected.contentHash) throw new Error("A confirmed statement hash changed after snapshot source freeze.");
    }
    if (manifest.kmbEntries.length) {
      if (!this.curatedKnowledgeProvider) {
        throw new Error("Curated KMB source revalidation is unavailable for this compiler.");
      }
      const currentEntries = await this.curatedKnowledgeProvider.getEntries(manifest.kmbEntries.map((item) => item.id));
      const currentManifest = currentEntries.map((entry) => ({ id: entry.id, contentHash: entry.contentHash })).sort((left, right) => left.id.localeCompare(right.id));
      const expectedManifest = [...manifest.kmbEntries].sort((left, right) => left.id.localeCompare(right.id));
      if (canonicalize(currentManifest) !== canonicalize(expectedManifest)) {
        throw new Error("Curated KMB content changed after snapshot source freeze.");
      }
    }
  }

  private async recordOperation(caseId: string, callPlanId: string, operationId: string, kind: string, status: string, payload: unknown) {
    await this.database.execute(
      `INSERT INTO preparation_operation_events (id, case_id, call_plan_id, operation_id, operation_kind, status, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [`preparation_event_${crypto.randomUUID()}`, caseId, callPlanId, operationId, kind, status, encodeJson(payload), Date.now()]
    );
  }
}
