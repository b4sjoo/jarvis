import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { MemoryEntry, MemoryRetrievalRequest } from "../../src/lib/memory/types.js";
import type { retrieveMemoryContext } from "../../src/lib/memory/retrieval.js";
import type { PreparationMaterialRepository, PreparationRetrievalPurpose } from "../../src/lib/preparation/types.js";
import type { PreparationMaterialContextRepository } from "../../src/lib/preparation/context-types.js";
import type { PreparationConversationRepository } from "../../src/lib/preparation/conversation-types.js";
import { createPreparationConversationService } from "../../src/lib/preparation/conversation-service.js";
import type { InterviewProcessRepository } from "../../src/lib/preparation/interview-types.js";

let instance = 0;
export async function preparationPurposeFixture() {
  const db = new DatabaseSync(":memory:");
  const migrations = [...readFileSync("src-tauri/src/db/main.rs", "utf8").matchAll(/include_str!\("migrations\/([^"]+)"\)/g)].map((m) => m[1]);
  for (const file of migrations.filter((f) => f !== "preparation-material-purpose.sql")) db.exec(readFileSync(`src-tauri/src/db/migrations/${file}`, "utf8"));
  db.exec(`INSERT INTO preparation_workspaces VALUES ('p','interview','Fixture','active',1,1,NULL);
    INSERT INTO interview_processes (id,workspace_id,created_at,updated_at) VALUES ('p','p',1,1);
    INSERT INTO interview_rounds (id,process_id,title,stage,expected_interview_types,expected_type_policy,created_at,updated_at)
      VALUES ('other-round','p','Other','behavioral','[]','advisory',1,1);
    INSERT INTO preparation_materials (id,workspace_id,scope_kind,display_name,original_file_name,mime_type,size_bytes,checksum_sha256,storage_relative_path,status,created_at,updated_at)
      VALUES ('legacy','p','workspace','Legacy','Legacy.txt','text/plain',1,'legacy','fixture/legacy','ready',1,1);`);
  db.exec(readFileSync("src-tauri/src/db/migrations/preparation-material-purpose.sql", "utf8"));
  const memory: MemoryEntry[] = [];
  const queries: MemoryRetrievalRequest[] = [];
  const sql: string[] = [];
  const database = {
    async select(query: string, values: SQLInputValue[] = []) { sql.push(query); return db.prepare(query).all(...values); },
    async execute(query: string, values: SQLInputValue[] = []) { const result = db.prepare(query).run(...values); return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) }; },
  };
  const key = `__purposeFixture${++instance}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[key] = { database, runtime: {
    async readSnapshot() { return { entries: structuredClone(memory), telemetry: {} }; },
    enqueueUsage() { return { enqueueMs: 0, queueDepth: 0, addedEntryCount: 0 }; },
    getUsageQueueDepth() { return 0; }, getLastUsageFlush() { return undefined; },
  } };
  const url = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
  const configUrl = url(`export const getDatabase = async () => globalThis.${key}.database;`);
  const memoryDbUrl = url("export const loadMemoryEntriesForSnapshot = () => { throw Error('Real memory DB forbidden'); }; export const markMemoryEntriesUsedBatch = () => { throw Error('Real usage write forbidden'); };");
  const runtimeUrl = url(`export const getSharedMemoryRetrievalRuntime = () => globalThis.${key}.runtime;`);
  const memoryUrl = url(stripTypeScriptTypes(readFileSync("src/lib/memory/retrieval.ts", "utf8")) + `\n// ${key}`);
  const repositoryUrls = ["preparation-material", "preparation-context", "preparation-conversation"].map((file) => url(stripTypeScriptTypes(readFileSync(`src/lib/database/${file}.action.ts`, "utf8")) + `\n// ${key}`));
  const hooks = registerHooks({ resolve(specifier, context, next) {
    const resolved = specifier === "./config" && repositoryUrls.includes(context.parentURL ?? "") ? configUrl
      : context.parentURL === memoryUrl && specifier === "@/lib/database/memory.action" ? memoryDbUrl
      : context.parentURL === memoryUrl && specifier === "./retrieval-runtime" ? runtimeUrl
      : context.parentURL === memoryUrl && specifier.startsWith("./") ? new URL(`../../src/lib/memory/${specifier.slice(2)}${specifier.endsWith(".js") ? "" : ".js"}`, import.meta.url).href
      : undefined;
    return resolved ? { url: resolved, shortCircuit: true } : next(specifier, context);
  } });
  const materialRepo = (await import(repositoryUrls[0])).preparationMaterialRepository as PreparationMaterialRepository;
  const contextRepo = (await import(repositoryUrls[1])).preparationMaterialContextRepository as PreparationMaterialContextRepository;
  const conversationRepo = (await import(repositoryUrls[2])).preparationConversationRepository as PreparationConversationRepository;
  const retrieve = (await import(memoryUrl)).retrieveMemoryContext as typeof retrieveMemoryContext;
  const process = { id: "p", workspaceId: "p", title: "Fixture", status: "active" as const, createdAt: 1, updatedAt: 1 };
  const interviewProcesses = { async getProcess() { return process; }, async getRound() { return undefined; } } as unknown as InterviewProcessRepository;
  let nextId = 0;
  const conversations = createPreparationConversationService({ repository: conversationRepo, interviewProcesses, createId: () => `${key}-${++nextId}` });
  const conversation = await conversations.create({ processId: "p", scope: { kind: "process" } });
  return { db, memory, queries, sql, materialRepo, contextRepo, conversationRepo, conversations, conversation, process, interviewProcesses,
    async retrieveKmb(input: MemoryRetrievalRequest) { queries.push(input); return retrieve(input); },
    async material(id: string, purpose?: PreparationRetrievalPurpose, options: { review?: boolean; round?: boolean; chunks?: number; content?: string } = {}) {
      await materialRepo.insert({
        material: { id, workspaceId: "p", scope: options.round ? { kind: "round", roundId: "other-round" } : { kind: "workspace" }, purpose,
          displayName: id, originalFileName: `${id}.txt`, mimeType: "text/plain", sizeBytes: 1, checksumSha256: id,
          storageRelativePath: `fixture/${id}`, status: "extracting", createdAt: 1, updatedAt: 1 },
        revision: { id: `r-${id}`, materialId: id, revision: 1, sourceChecksumSha256: id, extractionStatus: "extracting", createdAt: 1 },
        sourceRef: { id: `s-${id}`, workspaceId: "p", materialId: id, materialRevisionId: `r-${id}`, sourceKind: "user-upload", locator: id, contentHash: id, createdAt: 1 },
      });
      db.prepare("UPDATE preparation_material_revisions SET extraction_request_id='extract' WHERE id=?").run(`r-${id}`);
      for (let i = 0; i < (options.chunks ?? 1); i++) {
        const content = options.content ?? `iterate experiment ${id} detail ${i}`;
        db.prepare(`INSERT INTO preparation_material_chunks (id,workspace_id,material_id,material_revision_id,extraction_request_id,ordinal,content,search_text,page,created_at,source_method)
          VALUES (?,'p',?,?,'extract',?,?,?,?,1,'plain-text')`).run(`${id}-${i}`, id, `r-${id}`, i, content, content.toLowerCase(), i + 1);
      }
      db.prepare("UPDATE preparation_material_revisions SET extraction_status=?,review_status=? WHERE id=?").run(options.review ? "needs-review" : "ready", options.review ? "needs-review" : "unreviewed", `r-${id}`);
      db.prepare("UPDATE preparation_materials SET selected_revision_id=?,status=? WHERE id=?").run(`r-${id}`, options.review ? "needs-review" : "ready", id);
    },
    async seedHistory(content: string) {
      const lease = await conversations.beginRequest({ processId: "p", conversationId: conversation.id, content });
      await conversations.commitAssistant({ lease, content: "Earlier discussion, not factual evidence.", modelExecutionRef: "fixture",
        contextSnapshot: { providerId: "fixture", operationId: lease.operationId, conversationRevision: lease.expectedRevision,
          scope: { kind: "process" }, sourceRefs: [], budget: { totalChars: 0, maxChars: 30000, processMetadataChars: 0,
            rollingSummaryChars: 0, recentMessageChars: 0, materialChars: 0, kmbChars: 0, selectedMaterialChunks: 0,
            selectedKmbEntries: 0, omittedMaterialChunks: 0, omittedKmbEntries: 0, truncationReasons: [] }, createdAt: 1 } });
    },
    close() { hooks.deregister(); delete globals[key]; db.close(); },
  };
}

export function memoryEntry(id: string, type: MemoryEntry["type"] = "personal_story", overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id, type, title: `iterate experiment ${id}`, content: `Verified fixture context ${id}`, sourceIds: [], scope: "global",
    tags: [], keywords: ["iterate", "experiment"], priority: "normal", enabled: true, injectionMode: "retrieval", useCases: ["general_chat"],
    confidentiality: "normal", curationStatus: "curated", relatedEntryIds: [], evidenceEntryIds: [], createdAt: 1, updatedAt: 1,
    interviewFamilies: [], contentRevision: 1, ...overrides };
}
