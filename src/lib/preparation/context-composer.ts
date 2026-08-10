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
      const queryTokens = tokenizePreparationQuery(query);
      const materialInventoryRequest = isMaterialInventoryQuery(query);
      const preferredMaterialIds = uniqueStrings(
        input.preferredMaterialIds ?? input.lease.userMessage.materialRefs
      );
      const [materialCandidates, inventoryItems, memoryResult] =
        await Promise.all([
          materialInventoryRequest
            ? Promise.resolve([])
            : dependencies.materials.searchCandidates({
                processId: input.process.id,
                roundId: input.round?.id,
                queryTokens,
                preferredMaterialIds,
                limit: MATERIAL_CANDIDATE_LIMIT,
              }),
          materialInventoryRequest
            ? dependencies.materialInventory.list(input.process.id)
            : Promise.resolve([]),
          materialInventoryRequest
            ? Promise.resolve(undefined)
            : retrieveKmb({
                sessionId: `preparation:${input.process.id}`,
                query,
                useCase: "general_chat",
                maxEntries: MAX_KMB_ENTRIES,
                maxChars: MAX_KMB_CHARS,
                perEntryMaxChars: 1_600,
              }).catch(() => undefined),
        ]);

      const metadata = truncateText(
        formatProcessMetadata(input),
        MAX_METADATA_CHARS
      );
      const history = selectRecentHistory(
        input.messages,
        input.lease.logicalTurnId
      );
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
      const materials = materialInventoryRequest
        ? emptySelectedContext()
        : selectMaterialContext({
            candidates: materialCandidates,
            query,
            queryTokens,
            preferredMaterialIds,
            roundId: input.round?.id,
          });
      const documentOverview = materials.sourceRefs.some(
        (source) => source.sourceMethod === "document-overview"
      );
      const kmb = documentOverview || materialInventoryRequest
        ? emptySelectedContext()
        : selectKmbContext(memoryResult);
      const truncationReasons = [
        ...(metadata.truncated ? ["process-metadata-budget"] : []),
        ...history.truncationReasons,
        ...(summary.truncated ? ["rolling-summary-budget"] : []),
        ...(materials.omittedCount ? ["material-budget"] : []),
        ...(materialInventory.omittedCount
          ? ["material-inventory-budget"]
          : []),
        ...(documentOverview ? ["kmb-skipped-document-overview"] : []),
        ...(materialInventoryRequest
          ? ["kmb-skipped-material-inventory"]
          : []),
        ...(!materialInventoryRequest && memoryResult === undefined
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

      return {
        systemContext: [
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
          .join("\n\n"),
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
      query
        .normalize("NFKC")
        .toLowerCase()
        .match(/[\p{L}\p{N}][\p{L}\p{N}_+.#/-]*/gu) ?? []
    ).map((token) => token.replace(/[./-]+$/u, ""))
  )
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token))
    .sort((left, right) => right.length - left.length)
    .slice(0, 12);
}

export function selectMaterialContext(input: {
  candidates: PreparationMaterialContextCandidate[];
  query: string;
  queryTokens: string[];
  preferredMaterialIds: string[];
  roundId?: string;
}): PreparationSelectedContext {
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
      MAX_MATERIAL_CHARS
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
    if (selected.length >= MAX_MATERIAL_CHUNKS) break;
    const count = perMaterial.get(item.candidate.materialId) ?? 0;
    if (count >= MAX_MATERIAL_CHUNKS_PER_MATERIAL) continue;
    const remaining = MAX_MATERIAL_CHARS - selectedChars;
    if (remaining <= 0) break;
    const content = truncateText(item.candidate.content, remaining);
    if (!content.text) continue;
    selected.push({
      ...item,
      content: content.text,
      truncated: content.truncated,
    });
    selectedChars += content.text.length;
    perMaterial.set(item.candidate.materialId, count + 1);
  }

  const sourceRefs: PreparationContextSourceRef[] = selected.map(
    ({ candidate, score, content, truncated }) => ({
      kind: "material",
      id: candidate.chunkId,
      title: candidate.materialName,
      materialId: candidate.materialId,
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
    .map(({ candidate, content }, index) => {
      const location = [
        candidate.page ? `page=${candidate.page}` : "",
        candidate.section ? `section=${candidate.section}` : "",
        `method=${candidate.sourceMethod}`,
        candidate.materialStatus === "needs-review"
          ? "completeness=needs-review"
          : "completeness=ready",
      ]
        .filter(Boolean)
        .join(" ");
      return `[M${index + 1}] ${candidate.materialName} (${location})\n${content}`;
    })
    .join("\n\n");

  return {
    text,
    sourceRefs,
    selectedCount: selected.length,
    omittedCount: Math.max(0, input.candidates.length - selected.length),
    selectedChars,
  };
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
  maxChars: number
): PreparationSelectedContext {
  const selectedIds = new Set(materialIds);
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

  const perMaterialBudget = Math.max(1, Math.floor(maxChars / groups.length));
  const sections: string[] = [];
  const sourceRefs: PreparationContextSourceRef[] = [];
  let selectedChars = 0;
  let coveredChunks = 0;
  let sampled = false;

  for (const group of groups) {
    const first = group[0];
    const header = `${first.materialName} (document-wide sampled index; ${group.length} chunks available)`;
    const prefixBudget = Math.max(0, perMaterialBudget - header.length - 2);
    const excerptBudget = Math.max(
      48,
      Math.floor(prefixBudget / Math.max(1, group.length))
    );
    const excerpts: string[] = [];
    let used = 0;

    for (const candidate of group) {
      const location = candidate.page
        ? `page ${candidate.page}`
        : `chunk ${coveredChunks + 1}`;
      const prefix = `[${location}] `;
      const remaining = prefixBudget - used;
      if (remaining <= prefix.length + 8) {
        sampled = true;
        break;
      }
      const excerpt = representativeExcerpt(
        candidate.content,
        Math.min(excerptBudget, remaining - prefix.length)
      );
      if (!excerpt) continue;
      excerpts.push(`${prefix}${excerpt}`);
      used += prefix.length + excerpt.length + 1;
      coveredChunks += 1;
      sampled ||= excerpt.length < candidate.content.length;
    }

    const section = `${header}\n${excerpts.join("\n")}`;
    sections.push(section);
    selectedChars += section.length;
    sourceRefs.push({
      kind: "material",
      id: `overview:${first.materialRevisionId}`,
      title: first.materialName,
      materialId: first.materialId,
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

  const unselectedCandidates = candidates.filter(
    (candidate) => !selectedIds.has(candidate.materialId)
  ).length;
  return {
    text: sections.join("\n\n"),
    sourceRefs,
    selectedCount: coveredChunks,
    omittedCount: unselectedCandidates + (sampled ? 1 : 0),
    selectedChars,
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
  result: MemoryRetrievalResult | undefined
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
  const selected = result.entries.slice(0, MAX_KMB_ENTRIES);
  const sourceRefs: PreparationContextSourceRef[] = selected.map((item) => ({
    kind: "kmb",
    id: item.entry.id,
    title: item.entry.title,
    score: item.score,
    selectedChars: item.injectedContent.length,
    truncated: item.injectedContent.length < item.entry.content.length,
  }));
  return {
    text: selected
      .map(
        (item, index) =>
          `[K${index + 1}] ${item.entry.title} (id=${item.entry.id})\n${item.injectedContent}`
      )
      .join("\n\n"),
    sourceRefs,
    selectedCount: selected.length,
    omittedCount: Math.max(0, result.eligibleCount - selected.length),
    selectedChars: selected.reduce(
      (total, item) => total + item.injectedContent.length,
      0
    ),
  };
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
