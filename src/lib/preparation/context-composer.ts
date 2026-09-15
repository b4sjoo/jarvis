import type {
  MemoryRetrievalRequest,
  MemoryRetrievalResult,
} from "../memory/types.js";
import type { Message } from "../../types/index.js";
import type {
  PreparationContextComposerInput,
  PreparationContextComposition,
  PreparationMaterialContextCandidate,
  PreparationMaterialContextRepository,
  PreparationMaterialInventoryRepository,
  PreparationMaterialInventorySelection,
  PreparationSelectedContext,
} from "./context-types.js";
import type {
  PreparationContextSourceRef,
  PreparationMessage,
} from "./conversation-types.js";
import { preparationMemoryPurpose } from "../memory/preparation-purpose.js";
import type { PreparationQueryTrace } from "./conversation-types.js";

const MAX_CONTEXT_CHARS = 30_000;
const MAX_METADATA_CHARS = 2_000;
const MAX_RECENT_TURNS = 8;
const MAX_RECENT_MESSAGE_CHARS = 12_000;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_MATERIAL_CHUNKS = 6;
const MAX_MATERIAL_CHARS = 8_000;
const MAX_MATERIAL_INVENTORY_ITEMS = 100;
const MAX_MATERIAL_CHUNKS_PER_MATERIAL = 3;
const MAX_KMB_ENTRIES = 3;
const MAX_KMB_CHARS = 4_000;
const MATERIAL_CANDIDATE_LIMIT = 300;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "can",
  "could",
  "do",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "tell",
  "that",
  "the",
  "this",
  "to",
  "use",
  "uses",
  "using",
  "was",
  "what",
  "when",
  "which",
  "with",
  "would",
  "you",
  "your",
]);

export interface PreparationContextComposerDependencies {
  materials: PreparationMaterialContextRepository;
  materialInventory: PreparationMaterialInventoryRepository;
  retrieveKmb: (
    input: MemoryRetrievalRequest
  ) => Promise<MemoryRetrievalResult>;
}

export function createPreparationContextComposer(
  dependencies: PreparationContextComposerDependencies
) {
  const retrieveKmb = dependencies.retrieveKmb;

  return {
    async compose(
      input: PreparationContextComposerInput
    ): Promise<PreparationContextComposition> {
      const query = input.lease.userMessage.content;
      const materialInventoryRequest = isMaterialInventoryQuery(query);
      const preferredMaterialIds = uniqueStrings(
        input.preferredMaterialIds ?? input.lease.userMessage.materialRefs
      );
      await input.assertCurrent?.();
      // Capture labels before the asynchronous rewrite; review/deletion still gate SQL reads.
      const inventoryItems = await dependencies.materialInventory.list(input.process.id);
      const purposes = new Map(inventoryItems.map((material) => [material.id, material.purpose]));
      const metadata = truncateText(
        formatProcessMetadata(input),
        MAX_METADATA_CHARS
      );
      const history = selectRecentHistory(
        input.messages,
        input.lease.logicalTurnId
      );
      let queryTrace: PreparationQueryTrace = {
        originalQuery: query.slice(0, 12_000),
        queries: { guidance: query, "personal-context": query },
        historyMessageIds: history.messageIds,
        disposition: materialInventoryRequest ? "inventory" : preferredMaterialIds.length ? "manual" : "no-history",
        durationMs: 0, outputChars: 0,
      };
      if (!materialInventoryRequest && !preferredMaterialIds.length && history.messages.length && input.rewriteQueries) {
        queryTrace = await input.rewriteQueries({ query, history: history.messages, historyMessageIds: history.messageIds, sourceRefs: history.sourceRefs });
      }
      await input.assertCurrent?.();
      const pools = await Promise.all((["guidance", "personal-context"] as const).map(async (purpose) => {
        const poolQuery = queryTrace.queries[purpose];
        const queryTokens = tokenizePreparationQuery(poolQuery);
        const [candidates, memory] = materialInventoryRequest ? [[], undefined] as const : await Promise.all([
          preferredMaterialIds.length && purpose === "personal-context"
            ? Promise.resolve([])
            : dependencies.materials.searchCandidates({
            processId: input.process.id, roundId: input.round?.id, queryTokens,
            preferredMaterialIds, limit: MATERIAL_CANDIDATE_LIMIT,
            // Explicit recovery retains its existing unlabelled-material access.
            ...(preferredMaterialIds.length ? {} : {
              purpose, purposeMaterialIds: inventoryItems.filter((m) => m.purpose === purpose).map((m) => m.id),
            }),
          }),
          retrieveKmb({
            sessionId: `preparation:${input.process.id}`,
            query: normalizePreparationRetrievalQuery(poolQuery),
            useCase: "general_chat", preparationPurpose: purpose,
            maxEntries: MAX_KMB_ENTRIES, maxChars: MAX_KMB_CHARS, perEntryMaxChars: 1_600,
          }).catch(() => undefined),
        ]);
        return { purpose, query: poolQuery, queryTokens,
          candidates: candidates.filter((c) => preferredMaterialIds.length
            ? purpose === "guidance"
            : purposes.get(c.materialId) === purpose).map((c) => ({ ...c, purpose: purposes.get(c.materialId) })),
          memory: memory ? { ...memory, entries: memory.entries.filter((item) => preparationMemoryPurpose(item.entry) === purpose) } : undefined,
        };
      }));
      await input.assertCurrent?.();
      const summary = buildRollingSummary(
        input.messages,
        input.lease.logicalTurnId,
        history.includedTurnIds
      );
      const materialInventory = materialInventoryRequest
        ? selectMaterialInventoryContext({
            materials: inventoryItems,
            roundId: input.round?.id,
          })
        : emptyMaterialInventory();
      const materialLimits = allocatePoolCapacity(MAX_MATERIAL_CHUNKS, pools.map((pool) => materialCapacity(pool.candidates)), 3);
      const kmbLimits = allocatePoolCapacity(MAX_KMB_ENTRIES, pools.map((pool) => pool.memory?.entries.length ?? 0), 1);
      const materialDemands = pools.map((pool, index) => selectMaterialContext({ ...pool, preferredMaterialIds, roundId: input.round?.id, maxChunks: materialLimits[index] }));
      const materialChars = allocatePoolCapacity(MAX_MATERIAL_CHARS - 2, materialDemands.map((m) => m.text.length), Math.floor((MAX_MATERIAL_CHARS - 2) * materialLimits[0] / Math.max(1, materialLimits[0] + materialLimits[1])));
      const kmbDemands = pools.map((pool, index) => selectKmbContext(pool.memory, kmbLimits[index]));
      const kmbChars = allocatePoolCapacity(MAX_KMB_CHARS - 2, kmbDemands.map((m) => m.text.length), Math.floor((MAX_KMB_CHARS - 2) * kmbLimits[0] / Math.max(1, kmbLimits[0] + kmbLimits[1])));
      let materialLabelOffset = 0;
      const materialSelections = pools.map((pool, index) => {
        const selected = selectMaterialContext({ ...pool, preferredMaterialIds, roundId: input.round?.id, maxChunks: materialLimits[index], maxChars: materialChars[index], labelOffset: materialLabelOffset });
        materialLabelOffset += selected.sourceRefs.length;
        return selected;
      });
      let kmbLabelOffset = 0;
      const kmbSelections = pools.map((pool, index) => {
        const selected = selectKmbContext(pool.memory, kmbLimits[index], kmbChars[index], kmbLabelOffset);
        kmbLabelOffset += selected.sourceRefs.length;
        return selected;
      });
      const materials = mergeSelections(materialSelections);
      const kmb = mergeSelections(kmbSelections);
      const truncationReasons = [
        ...(metadata.truncated ? ["process-metadata-budget"] : []),
        ...history.truncationReasons,
        ...(summary.truncated ? ["rolling-summary-budget"] : []),
        ...(materials.omittedCount ? ["material-budget"] : []),
        ...(materialInventory.omittedCount
          ? ["material-inventory-budget"]
          : []),
        ...(materialInventoryRequest
          ? ["kmb-skipped-material-inventory"]
          : []),
        ...(!materialInventoryRequest && pools.some((pool) => pool.memory === undefined)
          ? ["kmb-unavailable"]
          : []),
        ...(kmb.omittedCount ? ["kmb-budget"] : []),
      ];
      const sourceRefs = [
        ...materialInventory.sourceRefs,
        ...materials.sourceRefs,
        ...kmb.sourceRefs,
      ];
      const budget = {
        totalChars:
          metadata.text.length +
          history.selectedChars +
          (summary.text?.length ?? 0) +
          materialInventory.selectedChars +
          materials.selectedChars +
          kmb.selectedChars,
        maxChars: MAX_CONTEXT_CHARS,
        processMetadataChars: metadata.text.length,
        rollingSummaryChars: summary.text?.length ?? 0,
        recentMessageChars: history.selectedChars,
        materialChars:
          materialInventory.selectedChars + materials.selectedChars,
        kmbChars: kmb.selectedChars,
        selectedMaterialChunks: materials.selectedCount,
        selectedMaterialInventoryItems:
          materialInventory.selectedItems.length,
        selectedKmbEntries: kmb.selectedCount,
        omittedMaterialChunks: materials.omittedCount,
        omittedMaterialInventoryItems: materialInventory.omittedCount,
        omittedKmbEntries: kmb.omittedCount,
        truncationReasons,
      };

      const formatContext = () => [
          `<process_metadata>\n${metadata.text}\n</process_metadata>`,
          summary.text
            ? `<generated_non_authoritative_summary>\n${summary.text}\n</generated_non_authoritative_summary>`
            : "",
          materialInventory.text
            ? `<material_inventory>\n${materialInventory.text}\n</material_inventory>`
            : "",
          materials.text
            ? `<untrusted_material_evidence>\n${materials.text}\n</untrusted_material_evidence>`
            : "",
          kmb.text
            ? `<curated_memory_evidence>\n${kmb.text}\n</curated_memory_evidence>`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n");
      let systemContext = formatContext();
      const overflow = systemContext.length + history.selectedChars - MAX_CONTEXT_CHARS;
      if (overflow > 0 && summary.text) {
        summary.text = summary.text.slice(0, Math.max(0, summary.text.length - overflow));
        budget.rollingSummaryChars = summary.text.length;
        budget.truncationReasons.push("total-context-budget");
        systemContext = formatContext();
      }
      budget.totalChars = systemContext.length + history.selectedChars;
      return {
        systemContext,
        retrieval: { ...queryTrace, pools: pools.map((pool, index) => ({
          purpose: pool.purpose, materialCandidateCount: pool.candidates.length,
          selectedMaterialChunks: materialSelections[index].selectedCount,
          selectedKmbEntries: kmbSelections[index].selectedCount,
          kmbUnavailable: !materialInventoryRequest && pool.memory === undefined,
          kmbRejectSummary: pool.memory?.rejectSummary ?? [],
        })) },
        recentHistory: history.messages,
        rollingSummary: summary.text,
        summaryThroughMessageId: summary.throughMessageId,
        sourceRefs,
        budget,
      };
    },
  };
}

export function isMaterialInventoryQuery(query: string) {
  const normalized = query.normalize("NFKC").toLowerCase();
  const contentRequest =
    /\b(?:analyze|analyse|summarize|summarise|explain|compare|extract|read|review|discuss|contain|contents?)\b/u.test(
      normalized
    ) ||
    /(?:分析|总结|解释|比较|提取|读取|审查|讨论|包含|内容|里面)/u.test(normalized);
  if (contentRequest) return false;
  const englishMaterial =
    /\b(?:materials|files|documents|attachments|uploads|sources)\b/u.test(
      normalized
    );
  const englishInventory = [
    /\b(?:list|show)\b/u,
    /\b(?:available|uploaded|attached|visible|current|scope|loaded)\b/u,
    /\b(?:can|could|do)\s+you\s+(?:see|access|have)\b/u,
    /\bhow many\b/u,
  ].some((pattern) => pattern.test(normalized));
  const chineseMaterial = /(?:材料|文件|文档|附件|上传内容)/u.test(normalized);
  const chineseInventory = [
    /(?:哪些|有什么|有哪些|多少)/u,
    /(?:当前|范围|可见|可用|上传).{0,12}(?:材料|文件|文档|附件)/u,
    /(?:材料|文件|文档|附件).{0,12}(?:当前|范围|可见|可用|上传)/u,
    /(?:列出|显示)(?:所有|全部|当前|可见|上传).{0,12}(?:材料|文件|文档|附件)/u,
    /(?:能|可以).{0,4}(?:看|访问).{0,8}(?:材料|文件|文档|附件)/u,
  ].some((pattern) => pattern.test(normalized));
  return (
    (englishMaterial && englishInventory) ||
    (chineseMaterial && chineseInventory)
  );
}

export function selectMaterialInventoryContext(input: {
  materials: Awaited<
    ReturnType<PreparationMaterialInventoryRepository["list"]>
  >;
  roundId?: string;
}): PreparationMaterialInventorySelection {
  const visible = input.materials
    .filter(
      (material) =>
        material.status !== "deleted" &&
        (material.scope.kind === "workspace" ||
          (material.scope.kind === "round" &&
            material.scope.roundId === input.roundId))
    )
    .sort(
      (left, right) =>
        Number(right.scope.kind === "round") -
          Number(left.scope.kind === "round") ||
        left.displayName.localeCompare(right.displayName) ||
        left.id.localeCompare(right.id)
    );
  const selectedItems = visible.slice(0, MAX_MATERIAL_INVENTORY_ITEMS);
  const entries = selectedItems.map((material, index) => ({
    label: `M${index + 1}`,
    material,
    line: `[M${index + 1}] ${JSON.stringify({
      materialId: material.id,
      name: material.displayName,
      type: material.extension || material.mimeType,
      scope:
        material.scope.kind === "workspace"
          ? "entire-process"
          : "current-round",
      status: material.status,
      purpose: material.purpose ?? "unlabelled",
    })}`,
  }));
  const header = [
    "Metadata-only inventory for the current conversation scope.",
    "Names and statuses are not material-content evidence.",
    "Only ready materials may contribute content to ordinary analysis; needs-review and other statuses are listed for visibility only.",
    "For a material-inventory request, answer only from this current inventory and do not add files remembered from conversation history.",
    `Visible materials: ${visible.length}.`,
  ].join("\n");
  const bounded = truncateInventoryEntries(
    entries,
    MAX_MATERIAL_CHARS - header.length - 2
  );
  const text = [header, ...bounded.entries.map((entry) => entry.line)].join(
    "\n"
  );
  const sourceRefs: PreparationContextSourceRef[] = bounded.entries.map(
    ({ material, line }) => ({
      kind: "material",
      id: `inventory:${material.id}`,
      title: material.displayName,
      materialId: material.id,
      purpose: material.purpose,
      sourceMethod: "material-inventory",
      materialStatus: material.status,
      warningCodes:
        material.status === "needs-review"
          ? ["material-needs-review", "metadata-only"]
          : material.status !== "ready"
            ? [`material-${material.status}`, "metadata-only"]
            : ["metadata-only"],
      selectedChars: line.length,
      truncated: false,
    })
  );
  return {
    text,
    sourceRefs,
    selectedItems: bounded.entries.map((entry) => entry.material),
    omittedCount: Math.max(0, visible.length - bounded.entries.length),
    selectedChars: text.length,
  };
}

function truncateInventoryEntries<T extends { line: string }>(
  entries: T[],
  maxChars: number
) {
  const selected: T[] = [];
  let used = 0;
  for (const entry of entries) {
    const required = entry.line.length + (selected.length ? 1 : 0);
    if (used + required > maxChars) break;
    selected.push(entry);
    used += required;
  }
  return { entries: selected };
}

function emptyMaterialInventory(): PreparationMaterialInventorySelection {
  return {
    text: "",
    sourceRefs: [],
    selectedItems: [],
    omittedCount: 0,
    selectedChars: 0,
  };
}

export function tokenizePreparationQuery(query: string) {
  return uniqueStrings(
    (
      normalizePreparationRetrievalQuery(query)
        .match(/[\p{L}\p{N}][\p{L}\p{N}_+.#/-]*/gu) ?? []
    ).map((token) => token.replace(/[./-]+$/u, ""))
  )
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token))
    .sort((left, right) => right.length - left.length)
    .slice(0, 12);
}

export function normalizePreparationRetrievalQuery(query: string) {
  const normalized = query.normalize("NFKC").toLowerCase();
  // Separate CJK words locally without splitting Latin technical identifiers.
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  return normalized.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu,
    (run) => ` ${[...segmenter.segment(run)].map((s) => s.segment).join(" ")} `);
}

function allocatePoolCapacity(total: number, demand: number[], guidanceReserve: number) {
  const selected = [Math.min(demand[0], guidanceReserve), Math.min(demand[1], total - guidanceReserve)];
  for (const index of [0, 1]) selected[index] += Math.min(demand[index] - selected[index], total - selected[0] - selected[1]);
  return selected;
}

function materialCapacity(candidates: PreparationMaterialContextCandidate[]) {
  const groups = new Map<string, number>();
  for (const c of candidates) groups.set(c.materialId, Math.min(3, (groups.get(c.materialId) ?? 0) + 1));
  return [...groups.values()].reduce((a, b) => a + b, 0);
}

function mergeSelections(selections: PreparationSelectedContext[]): PreparationSelectedContext {
  const text = selections.map((s) => s.text).filter(Boolean).join("\n\n");
  return { text, sourceRefs: selections.flatMap((s) => s.sourceRefs),
    selectedCount: selections.reduce((n, s) => n + s.selectedCount, 0),
    omittedCount: selections.reduce((n, s) => n + s.omittedCount, 0), selectedChars: text.length };
}

export function selectMaterialContext(input: {
  candidates: PreparationMaterialContextCandidate[];
  query: string;
  queryTokens: string[];
  preferredMaterialIds: string[];
  roundId?: string;
  maxChunks?: number;
  maxChars?: number;
  labelOffset?: number;
}): PreparationSelectedContext {
  const maxChunks = input.maxChunks ?? MAX_MATERIAL_CHUNKS;
  const maxChars = input.maxChars ?? MAX_MATERIAL_CHARS;
  if (!maxChunks || !maxChars) return { ...emptySelectedContext(), omittedCount: input.candidates.length };
  const preferred = new Set(input.preferredMaterialIds);
  const normalizedQuery = normalizeSearchText(input.query);
  const overviewMaterialIds = detectOverviewMaterialIds(
    input.candidates,
    normalizedQuery
  );
  if (overviewMaterialIds.length) {
    return selectDocumentOverviewContext(
      input.candidates,
      overviewMaterialIds,
      maxChars,
      maxChunks,
      input.labelOffset ?? 0
    );
  }
  const scored = input.candidates
    .map((candidate) => ({
      candidate,
      score: scoreMaterialCandidate(
        candidate,
        normalizedQuery,
        input.queryTokens,
        preferred,
        input.roundId
      ),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.materialName.localeCompare(right.candidate.materialName) ||
        left.candidate.chunkId.localeCompare(right.candidate.chunkId)
    );
  const selected: Array<{
    candidate: PreparationMaterialContextCandidate;
    score: number;
    content: string;
    truncated: boolean;
  }> = [];
  const perMaterial = new Map<string, number>();
  let selectedChars = 0;

  for (const item of scored) {
    if (selected.length >= maxChunks) break;
    const count = perMaterial.get(item.candidate.materialId) ?? 0;
    if (count >= MAX_MATERIAL_CHUNKS_PER_MATERIAL) continue;
    const header = formatMaterialHeader(item.candidate, selected.length + 1 + (input.labelOffset ?? 0));
    const remaining = maxChars - selectedChars - header.length - (selected.length ? 2 : 0);
    if (remaining <= 0) break;
    const content = truncateText(item.candidate.content, remaining);
    if (!content.text) continue;
    selected.push({
      ...item,
      content: content.text,
      truncated: content.truncated,
    });
    selectedChars += header.length + content.text.length + (selected.length > 1 ? 2 : 0);
    perMaterial.set(item.candidate.materialId, count + 1);
  }

  const sourceRefs: PreparationContextSourceRef[] = selected.map(
    ({ candidate, score, content, truncated }) => ({
      kind: "material",
      id: candidate.chunkId,
      title: candidate.materialName,
      materialId: candidate.materialId,
      purpose: candidate.purpose,
      materialRevisionId: candidate.materialRevisionId,
      page: candidate.page,
      section: candidate.section,
      sourceMethod: candidate.sourceMethod,
      confidence: candidate.confidence,
      pageCount: candidate.pageCount,
      ocrAverageConfidence: candidate.ocrAverageConfidence,
      materialStatus: candidate.materialStatus,
      warningCodes:
        candidate.materialStatus === "needs-review"
          ? uniqueStrings(["material-needs-review", ...candidate.warningCodes])
          : candidate.warningCodes,
      score,
      selectedChars: content.length,
      truncated,
    })
  );
  const text = selected
    .map(({ candidate, content }, index) => `${formatMaterialHeader(candidate, index + 1 + (input.labelOffset ?? 0))}${content}`)
    .join("\n\n");

  return {
    text,
    sourceRefs,
    selectedCount: selected.length,
    omittedCount: Math.max(0, input.candidates.length - selected.length),
    selectedChars,
  };
}

function formatMaterialHeader(candidate: PreparationMaterialContextCandidate, label: number) {
  const location = [candidate.page ? `page=${candidate.page}` : "",
    candidate.section ? `section=${candidate.section}` : "", `method=${candidate.sourceMethod}`,
    `purpose=${candidate.purpose ?? "unlabelled"}`, `completeness=${candidate.materialStatus}`].filter(Boolean).join(" ");
  return `[M${label}] ${candidate.materialName} (${location})\n`;
}

function detectOverviewMaterialIds(
  candidates: PreparationMaterialContextCandidate[],
  normalizedQuery: string
) {
  if (!isDocumentOverviewQuery(normalizedQuery)) return [];
  const names = new Map<string, string>();
  for (const candidate of candidates) {
    const normalizedName = normalizeSearchText(
      candidate.materialName.replace(/\.[^.]+$/u, "")
    );
    if (normalizedName.length >= 3) names.set(candidate.materialId, normalizedName);
  }
  return [...names.entries()]
    .filter(([, name]) => normalizedQuery.includes(name))
    .map(([materialId]) => materialId);
}

function isDocumentOverviewQuery(normalizedQuery: string) {
  return [
    "explain",
    "overview",
    "summarize",
    "summary",
    "how many",
    "list",
    "all",
    "complete",
    "entire",
    "whole",
    "what is",
    "介绍",
    "解释",
    "总结",
    "概览",
    "多少",
    "全部",
    "完整",
    "列出",
  ].some((signal) => normalizedQuery.includes(signal));
}

function selectDocumentOverviewContext(
  candidates: PreparationMaterialContextCandidate[],
  materialIds: string[],
  maxChars: number,
  maxChunks: number,
  labelOffset: number
): PreparationSelectedContext {
  const groups = materialIds
    .map((materialId) =>
      candidates
        .filter((candidate) => candidate.materialId === materialId)
        .sort(
          (left, right) =>
            (left.page ?? Number.MAX_SAFE_INTEGER) -
              (right.page ?? Number.MAX_SAFE_INTEGER) ||
            left.chunkId.localeCompare(right.chunkId)
        )
    )
    .filter((group) => group.length > 0);
  if (!groups.length) {
    return {
      text: "",
      sourceRefs: [],
      selectedCount: 0,
      omittedCount: candidates.length,
      selectedChars: 0,
    };
  }

  const perMaterialBudget = Math.max(1, Math.floor((maxChars - 2 * (groups.length - 1)) / groups.length));
  const sections: string[] = [];
  const sourceRefs: PreparationContextSourceRef[] = [];
  let selectedChars = 0;
  let coveredChunks = 0;

  for (const group of groups) {
    if (coveredChunks >= maxChunks) break;
    const first = group[0];
    const header = `[M${sourceRefs.length + 1 + labelOffset}] ${first.materialName} (purpose=${first.purpose ?? "unlabelled"}; document-wide sampled index; ${group.length} chunks available)`;
    const prefixBudget = Math.max(0, perMaterialBudget - header.length - 2);
    const excerptBudget = Math.max(
      48,
      Math.floor(prefixBudget / Math.max(1, group.length))
    );
    const excerpts: string[] = [];
    let used = 0;

    const sampleCount = Math.min(MAX_MATERIAL_CHUNKS_PER_MATERIAL, maxChunks - coveredChunks, group.length);
    const sample = Array.from({ length: sampleCount }, (_, i) => group[sampleCount === 1 ? 0 : Math.floor(i * (group.length - 1) / (sampleCount - 1))]);
    for (const candidate of sample) {
      const location = candidate.page
        ? `page ${candidate.page}`
        : `chunk ${coveredChunks + 1}`;
      const prefix = `[${location}] `;
      const remaining = prefixBudget - used;
      if (remaining <= prefix.length + 8) {
        break;
      }
      const excerpt = representativeExcerpt(
        candidate.content,
        Math.min(Math.max(excerptBudget, Math.floor(prefixBudget / sampleCount) - prefix.length - 1), remaining - prefix.length - 1)
      );
      if (!excerpt) continue;
      excerpts.push(`${prefix}${excerpt}`);
      used += prefix.length + excerpt.length + 1;
      coveredChunks += 1;
    }

    const section = `${header}\n${excerpts.join("\n")}`;
    if (!excerpts.length) continue;
    sections.push(section);
    selectedChars += section.length;
    sourceRefs.push({
      kind: "material",
      id: `overview:${first.materialRevisionId}`,
      title: first.materialName,
      materialId: first.materialId,
      purpose: first.purpose,
      materialRevisionId: first.materialRevisionId,
      sourceMethod: "document-overview",
      pageCount: first.pageCount,
      ocrAverageConfidence: first.ocrAverageConfidence,
      materialStatus: first.materialStatus,
      warningCodes: uniqueStrings([
        ...(first.materialStatus === "needs-review"
          ? ["material-needs-review"]
          : []),
        ...group.flatMap((candidate) => candidate.warningCodes),
        "material-overview-sampled",
      ]),
      selectedChars: section.length,
      truncated: true,
      availableChunks: group.length,
      coveredChunks: excerpts.length,
    });
  }

  return {
    text: sections.join("\n\n"),
    sourceRefs,
    selectedCount: coveredChunks,
    omittedCount: Math.max(0, candidates.length - coveredChunks),
    selectedChars: sections.join("\n\n").length,
  };
}

function representativeExcerpt(content: string, maxChars: number) {
  const normalized = content.replace(/\s+/gu, " ").trim();
  return truncateText(normalized || content.trim(), maxChars).text;
}

function emptySelectedContext(): PreparationSelectedContext {
  return {
    text: "",
    sourceRefs: [],
    selectedCount: 0,
    omittedCount: 0,
    selectedChars: 0,
  };
}

function selectKmbContext(
  result: MemoryRetrievalResult | undefined,
  maxEntries = MAX_KMB_ENTRIES,
  maxChars = MAX_KMB_CHARS,
  labelOffset = 0
): PreparationSelectedContext {
  if (!result) {
    return {
      text: "",
      sourceRefs: [],
      selectedCount: 0,
      omittedCount: 0,
      selectedChars: 0,
    };
  }
  const ranked = result.entries.slice(0, maxEntries);
  let remaining = maxChars;
  let labelCount = 0;
  const selected = ranked.flatMap((item, index) => {
    const header = formatKmbHeader(item, labelOffset + labelCount + 1);
    const contentBudget = Math.floor(remaining / (ranked.length - index)) - header.length - (index ? 2 : 0);
    if (contentBudget <= 0) return [];
    const injectedContent = truncateText(item.injectedContent, contentBudget).text;
    remaining -= header.length + injectedContent.length + (index ? 2 : 0);
    labelCount++;
    return [{ ...item, injectedContent }];
  });
  const sourceRefs: PreparationContextSourceRef[] = selected.map((item) => ({
    kind: "kmb",
    id: item.entry.id,
    purpose: preparationMemoryPurpose(item.entry),
    kmbEntryRevision: item.entry.contentRevision,
    title: item.entry.title,
    score: item.score,
    selectedChars: item.injectedContent.length,
    truncated: item.injectedContent.length < item.entry.content.length,
  }));
  return {
    text: selected
      .map(
        (item, index) => `${formatKmbHeader(item, index + 1 + labelOffset)}${item.injectedContent}`
      )
      .join("\n\n"),
    sourceRefs,
    selectedCount: selected.length,
    omittedCount: Math.max(0, result.entries.length - selected.length) +
      result.rejectSummary.filter((reason) => reason.reason === "budget-truncated").reduce((n, reason) => n + reason.count, 0),
    selectedChars: selected.reduce(
      (total, item, index) => total + formatKmbHeader(item, index + 1 + labelOffset).length + item.injectedContent.length + (index ? 2 : 0),
      0
    ),
  };
}

function formatKmbHeader(item: MemoryRetrievalResult["entries"][number], label: number) {
  return `[K${label}] ${item.entry.title} (id=${item.entry.id}; purpose=${preparationMemoryPurpose(item.entry)}; role=${item.runtimeRole?.role ?? "reference"})\n`;
}

function selectRecentHistory(
  messages: PreparationMessage[],
  currentLogicalTurnId: string
) {
  const eligible = messages.filter(
    (message) => message.logicalTurnId !== currentLogicalTurnId
  );
  const orderedTurnIds = uniqueStrings(
    eligible.map((message) => message.logicalTurnId)
  );
  const includedTurnIds = new Set(orderedTurnIds.slice(-MAX_RECENT_TURNS));
  const candidates = eligible.filter((message) =>
    includedTurnIds.has(message.logicalTurnId)
  );
  const selected: PreparationMessage[] = [];
  let selectedChars = 0;
  const truncationReasons: string[] = [];

  for (const message of [...candidates].reverse()) {
    const remaining = MAX_RECENT_MESSAGE_CHARS - selectedChars;
    if (remaining <= 0) {
      truncationReasons.push("recent-message-budget");
      break;
    }
    const content = truncateText(message.content, remaining);
    selected.unshift({ ...message, content: content.text });
    selectedChars += content.text.length;
    if (content.truncated) {
      truncationReasons.push("recent-message-budget");
      break;
    }
  }

  return {
    messageIds: selected.map((message) => message.id),
    sourceRefs: selected.flatMap((message) => message.sourceRefs),
    messages: selected.map<Message>((message) => ({
      role: message.role,
      content: message.content,
    })),
    includedTurnIds,
    selectedChars,
    truncationReasons: uniqueStrings(truncationReasons),
  };
}

function buildRollingSummary(
  messages: PreparationMessage[],
  currentLogicalTurnId: string,
  recentTurnIds: Set<string>
) {
  const older = messages.filter(
    (message) =>
      message.logicalTurnId !== currentLogicalTurnId &&
      !recentTurnIds.has(message.logicalTurnId)
  );
  if (!older.length) {
    return {
      text: undefined,
      throughMessageId: undefined,
      truncated: false,
    };
  }
  const lines = older.map((message) => {
    const role = message.role === "assistant" ? "Jarvis" : "User";
    return `${role}: ${message.content.replace(/\s+/g, " ").trim()}`;
  });
  const raw = lines.join("\n");
  const prefix = "Earlier preparation recap (generated; verify against sources):\n";
  const truncated = truncateTextFromEnd(
    raw,
    Math.max(0, MAX_SUMMARY_CHARS - prefix.length)
  );
  return {
    text: `${prefix}${truncated.text}`,
    throughMessageId: older[older.length - 1]?.id,
    truncated: truncated.truncated,
  };
}

function formatProcessMetadata(input: PreparationContextComposerInput) {
  const process = input.process;
  const round = input.round;
  return [
    `Process: ${process.title}`,
    `Company: ${process.company ?? "unresolved"}`,
    `Role: ${process.role ?? "unresolved"}`,
    `Conversation scope: ${round ? `round:${round.title}` : "entire process"}`,
    round ? `Round stage: ${round.stage}` : "",
    round
      ? `Expected interview types (${round.expectedTypePolicy}): ${round.expectedInterviewTypes.join(", ") || "unresolved"}`
      : "",
    round?.scheduledAt
      ? `Scheduled: ${new Date(round.scheduledAt).toISOString()}`
      : "",
    round?.interviewerName
      ? `Interviewer: ${round.interviewerName}${round.interviewerRole ? `, ${round.interviewerRole}` : ""}`
      : "",
    round?.preferredProgrammingLanguage
      ? `Preferred programming language: ${round.preferredProgrammingLanguage}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function scoreMaterialCandidate(
  candidate: PreparationMaterialContextCandidate,
  normalizedQuery: string,
  queryTokens: string[],
  preferred: Set<string>,
  roundId: string | undefined
) {
  const content = candidate.searchText.toLowerCase();
  const title = candidate.materialName.toLowerCase();
  const section = candidate.section?.toLowerCase() ?? "";
  let score = preferred.has(candidate.materialId) ? 80 : 0;
  if (candidate.scopeKind === "round" && candidate.scopeId === roundId) score += 8;
  if (normalizedQuery.length >= 12 && content.includes(normalizedQuery)) score += 18;
  for (const token of queryTokens) {
    if (title.includes(token)) score += 6;
    if (section.includes(token)) score += 4;
    if (content.includes(token)) score += 2;
  }
  return score;
}

function normalizeSearchText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) return { text: value, truncated: false };
  if (maxChars <= 1) return { text: value.slice(0, maxChars), truncated: true };
  return { text: `${value.slice(0, maxChars - 1)}…`, truncated: true };
}

function truncateTextFromEnd(value: string, maxChars: number) {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: `…${value.slice(-(maxChars - 1))}`,
    truncated: true,
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}
