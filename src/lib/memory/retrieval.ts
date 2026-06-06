import {
  getEnabledMemoryEntries,
  markMemoryEntriesUsed,
} from "@/lib/database/memory.action";
import type {
  MemoryEntry,
  MemoryAskFrame,
  MemoryInterviewType,
  MemoryQuestionType,
  MemoryRetrievalRequest,
  MemoryRetrievalResult,
  MemoryTopicDomain,
  MemoryUseCase,
  RetrievedMemoryEntry,
} from "./types";

const DEFAULT_MAX_ENTRIES = 5;
const DEFAULT_MAX_CHARS = 6000;
const DEFAULT_PER_ENTRY_MAX_CHARS = 1200;

const PRIORITY_BOOST: Record<MemoryEntry["priority"], number> = {
  low: 0,
  normal: 4,
  high: 12,
  pinned: 24,
};

export async function retrieveMemoryContext({
  query,
  useCase,
  projectId,
  interviewTypes,
  questionType,
  askFrame,
  topicDomain,
  projectAnchor,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxChars = DEFAULT_MAX_CHARS,
  perEntryMaxChars = DEFAULT_PER_ENTRY_MAX_CHARS,
}: MemoryRetrievalRequest): Promise<MemoryRetrievalResult> {
  const entries = await getEnabledMemoryEntries();
  const eligibleEntries = entries.filter((entry) =>
    isEntryEligible(entry, useCase, interviewTypes, questionType)
  );
  const queryTokens = tokenize(query);
  const scoringContext = {
    useCase,
    projectId,
    askFrame,
    topicDomain,
    projectAnchor,
  };
  const alwaysEntries = eligibleEntries
    .filter(
      (entry) =>
        (entry.injectionMode === "always" || entry.priority === "pinned") &&
        hasRequiredTaggedHints(entry, query)
    )
    .map((entry) => scoreMemoryEntry(entry, queryTokens, scoringContext, true));
  const retrievalEntries = eligibleEntries
    .filter(
      (entry) =>
        entry.injectionMode === "retrieval" &&
        entry.priority !== "pinned" &&
        hasRequiredTaggedHints(entry, query)
    )
    .map((entry) => scoreMemoryEntry(entry, queryTokens, scoringContext, false))
    .filter(hasRetrievalMatch)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxEntries);

  const selected = dedupeRetrievedEntries([...alwaysEntries, ...retrievalEntries])
    .sort((left, right) => right.score - left.score);
  const budgeted = applyMemoryBudget(selected, maxChars, perEntryMaxChars);

  if (budgeted.entries.length) {
    void markMemoryEntriesUsed(budgeted.entries.map((entry) => entry.entry.id));
  }

  return {
    entries: budgeted.entries,
    contextText: formatMemoryContext(budgeted.entries),
    totalChars: budgeted.totalChars,
    candidateCount: eligibleEntries.length,
    rejectedCount: entries.length - eligibleEntries.length,
  };
}

export function formatMemorySelectionForTrace(result: MemoryRetrievalResult) {
  if (!result.entries.length) {
    return "No memory entries injected.";
  }

  return result.entries
    .map((item, index) => {
      const entry = item.entry;
      return [
        `${index + 1}. ${entry.title}`,
        `id=${entry.id}`,
        `type=${entry.type}`,
        `project=${entry.projectName || entry.projectId || entry.scope}`,
        `score=${item.score}`,
        `reason=${item.matchReason.join(", ") || "always"}`,
        "",
        item.injectedContent,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

function isEntryEligible(
  entry: MemoryEntry,
  useCase: MemoryUseCase,
  interviewTypes: MemoryInterviewType[] | undefined,
  questionType: MemoryQuestionType | undefined
) {
  if (!entry.enabled) return false;
  if (entry.injectionMode === "manual_only" || entry.injectionMode === "never") {
    return false;
  }
  if (entry.curationStatus !== "curated" && entry.curationStatus !== "verified") {
    return false;
  }
  return (
    entry.useCases.includes(useCase) ||
    entry.useCases.includes("meeting_assistant") ||
    entry.useCases.includes("general_chat")
  ) && isEntryAllowedByInterviewGate(entry, interviewTypes, questionType);
}

function isEntryAllowedByInterviewGate(
  entry: MemoryEntry,
  interviewTypes: MemoryInterviewType[] | undefined,
  questionType: MemoryQuestionType | undefined
) {
  const family = inferEntryInterviewFamily(entry);
  if (!family || family === "general") return true;

  const allowedTypes = normalizeAllowedInterviewTypes(interviewTypes);
  if (allowedTypes && !allowedTypes.has(family)) return false;

  if (
    questionType &&
    questionType !== "unknown" &&
    questionType !== "field-knowledge" &&
    !isQuestionTypeCompatibleWithFamily(questionType, family)
  ) {
    return false;
  }

  if (
    questionType &&
    questionType !== "unknown" &&
    questionType !== "behavioral" &&
    family === "behavioral"
  ) {
    return false;
  }

  return true;
}

function isQuestionTypeCompatibleWithFamily(
  questionType: MemoryQuestionType,
  family: Exclude<MemoryInterviewType, "mixed">
) {
  if (questionType === family) return true;
  if (
    questionType === "general-system-design" &&
    family === "system-design"
  ) {
    return true;
  }
  if (questionType === "system-design" && family === "system-design") {
    return true;
  }
  return false;
}

function normalizeAllowedInterviewTypes(
  interviewTypes: MemoryInterviewType[] | undefined
) {
  if (!interviewTypes?.length || interviewTypes.includes("mixed")) {
    return undefined;
  }

  return new Set(
    interviewTypes.filter(
      (type): type is Exclude<MemoryInterviewType, "mixed"> =>
        type !== "mixed"
    )
  );
}

function inferEntryInterviewFamily(
  entry: MemoryEntry
):
  | Exclude<MemoryInterviewType, "mixed">
  | "general"
  | undefined {
  const searchable = [
    entry.type,
    entry.title,
    entry.tags.join(" "),
    entry.keywords.join(" "),
    entry.useCases.join(" "),
  ]
    .join(" ")
    .toLowerCase();

  if (
    entry.type === "behavioral_question" ||
    entry.useCases.includes("behavioral_interview") ||
    /\b(behavioral|behavioural|leadership principle|lp:|star|company:amazon|rubric)\b/.test(
      searchable
    )
  ) {
    return isGuidanceOrQuestionBankEntry(entry) ? "behavioral" : undefined;
  }

  if (
    entry.type === "coding_question" ||
    entry.useCases.includes("coding_interview") ||
    /\b(coding|algorithm|leetcode|data structure)\b/.test(searchable)
  ) {
    return isGuidanceOrQuestionBankEntry(entry) ? "coding" : undefined;
  }

  if (
    /\b(ai\/ml|ml infra|machine learning|rag|retrieval augmented generation|model serving|model routing|vector search|embedding|agentic|agent memory|llm platform|evaluation)\b/.test(
      searchable
    )
  ) {
    return isGuidanceOrQuestionBankEntry(entry)
      ? "ai-ml-system-design"
      : undefined;
  }

  if (/\b(system design|architecture|distributed system)\b/.test(searchable)) {
    return isGuidanceOrQuestionBankEntry(entry) ? "system-design" : undefined;
  }

  if (/\b(project deep dive|project dive|deep-dive)\b/.test(searchable)) {
    return isGuidanceOrQuestionBankEntry(entry)
      ? "project-deep-dive"
      : undefined;
  }

  return "general";
}

function isGuidanceOrQuestionBankEntry(entry: MemoryEntry) {
  return (
    entry.type === "evaluation_criteria" ||
    entry.type === "interview_framework" ||
    entry.type === "answer_template" ||
    entry.type === "behavioral_question" ||
    entry.type === "technical_question" ||
    entry.type === "coding_question" ||
    entry.type === "cached_answer"
  );
}

interface MemoryScoringContext {
  useCase: MemoryUseCase;
  projectId?: string;
  askFrame?: MemoryAskFrame;
  topicDomain?: MemoryTopicDomain;
  projectAnchor?: string;
}

function scoreMemoryEntry(
  entry: MemoryEntry,
  queryTokens: Set<string>,
  context: MemoryScoringContext,
  always: boolean
): RetrievedMemoryEntry {
  const matchReason: string[] = [];
  let score = PRIORITY_BOOST[entry.priority];

  if (always) {
    score += 30;
    matchReason.push("always");
  }

  if (entry.useCases.includes(context.useCase)) {
    score += 20;
    matchReason.push(`useCase:${context.useCase}`);
  }

  if (entry.scope === "global") {
    score += 2;
  }

  if (context.projectId && entry.projectId === context.projectId) {
    score += 20;
    matchReason.push(`project:${context.projectId}`);
  }

  const searchable = buildEntrySearchableText(entry);
  if (context.projectAnchor) {
    const anchorTokens = tokenize(context.projectAnchor);
    const anchorMatches = countTokenOverlap(anchorTokens, tokenize(searchable));
    if (anchorMatches) {
      score += Math.min(anchorMatches * 8, 24);
      matchReason.push(`projectAnchor:${anchorMatches}`);
    }
  }

  if (context.topicDomain && context.topicDomain !== "unknown") {
    const domainMatches = countDomainSignalOverlap(
      context.topicDomain,
      searchable
    );
    if (domainMatches) {
      score += Math.min(domainMatches * 4, 16);
      matchReason.push(`topic:${context.topicDomain}`);
    }
  }

  if (context.askFrame === "past-project" && isProjectSpecificEntry(entry)) {
    score += 10;
    matchReason.push("askFrame:past-project");
  } else if (
    context.askFrame === "hypothetical-design" &&
    isSystemDesignGuidanceEntry(entry)
  ) {
    score += 8;
    matchReason.push("askFrame:hypothetical-design");
  }

  const titleMatches = countTokenOverlap(queryTokens, tokenize(entry.title));
  if (titleMatches) {
    score += titleMatches * 8;
    matchReason.push(`title:${titleMatches}`);
  }

  const tagMatches = countTokenOverlap(queryTokens, tokenize(entry.tags.join(" ")));
  if (tagMatches) {
    score += tagMatches * 10;
    matchReason.push(`tags:${tagMatches}`);
  }

  const keywordMatches = countTokenOverlap(
    queryTokens,
    tokenize(entry.keywords.join(" "))
  );
  if (keywordMatches) {
    score += keywordMatches * 6;
    matchReason.push(`keywords:${keywordMatches}`);
  }

  const summaryMatches = countTokenOverlap(
    queryTokens,
    tokenize([entry.summary, entry.content.slice(0, 600)].filter(Boolean).join(" "))
  );
  if (summaryMatches) {
    score += Math.min(summaryMatches * 2, 12);
    matchReason.push(`content:${summaryMatches}`);
  }

  return {
    entry,
    score,
    matchReason,
    injectedContent: entry.content,
  };
}

function buildEntrySearchableText(entry: MemoryEntry) {
  return [
    entry.projectId,
    entry.projectName,
    entry.type,
    entry.title,
    entry.tags.join(" "),
    entry.keywords.join(" "),
    entry.summary,
    entry.content.slice(0, 1000),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function countDomainSignalOverlap(
  topicDomain: Exclude<MemoryTopicDomain, "unknown">,
  searchable: string
) {
  const signals: Record<Exclude<MemoryTopicDomain, "unknown">, string[]> = {
    "ai-ml-infra": [
      "ai",
      "ml",
      "llm",
      "model",
      "embedding",
      "rag",
      "retrieval",
      "inference",
      "evaluation",
    ],
    "agentic-ai": [
      "agent",
      "agentic",
      "tool",
      "memory",
      "planner",
      "workflow",
      "autonomous",
    ],
    search: [
      "search",
      "semantic",
      "ranking",
      "retrieval",
      "opensearch",
      "neural",
      "vector",
    ],
    backend: [
      "backend",
      "service",
      "database",
      "api",
      "distributed",
      "scaling",
      "consistency",
    ],
  };

  return signals[topicDomain].filter((signal) => searchable.includes(signal))
    .length;
}

function isProjectSpecificEntry(entry: MemoryEntry) {
  return (
    entry.scope === "project" ||
    Boolean(entry.projectId || entry.projectName) ||
    [
      "answer_evidence",
      "working_summary",
      "project_context",
      "design_doc",
      "implementation_note",
      "decision_record",
      "investigation_note",
    ].includes(entry.type)
  );
}

function isSystemDesignGuidanceEntry(entry: MemoryEntry) {
  const searchable = buildEntrySearchableText(entry);
  return (
    entry.type === "interview_framework" ||
    entry.type === "evaluation_criteria" ||
    /\b(system design|architecture|distributed|scalability|consistency)\b/.test(
      searchable
    )
  );
}

function applyMemoryBudget(
  entries: RetrievedMemoryEntry[],
  maxChars: number,
  perEntryMaxChars: number
) {
  const budgetedEntries: RetrievedMemoryEntry[] = [];
  let totalChars = 0;

  for (const item of entries) {
    const headerChars = item.entry.title.length + item.entry.id.length + 80;
    const remaining = maxChars - totalChars - headerChars;
    if (remaining <= 0) break;

    const injectedContent = truncateText(
      item.entry.content,
      Math.min(perEntryMaxChars, remaining)
    );
    totalChars += injectedContent.length + headerChars;
    budgetedEntries.push({ ...item, injectedContent });
  }

  return { entries: budgetedEntries, totalChars };
}

function formatMemoryContext(entries: RetrievedMemoryEntry[]) {
  if (!entries.length) return "No memory context was injected.";

  return entries
    .map((item) => {
      const entry = item.entry;
      const lines = [
        `<memory_entry id="${entry.id}" type="${entry.type}" project="${
          entry.projectName || entry.projectId || entry.scope
        }" priority="${entry.priority}" score="${item.score}">`,
        `<title>${entry.title}</title>`,
        entry.summary ? `<summary>${entry.summary}</summary>` : undefined,
        `<content>${item.injectedContent}</content>`,
        `<source_ids>${entry.sourceIds.join(", ")}</source_ids>`,
        `<match_reason>${item.matchReason.join(", ") || "always"}</match_reason>`,
        "</memory_entry>",
      ].filter(Boolean);

      return lines.join("\n");
    })
    .join("\n\n");
}

function dedupeRetrievedEntries(entries: RetrievedMemoryEntry[]) {
  const entryMap = new Map<string, RetrievedMemoryEntry>();
  for (const entry of entries) {
    const existing = entryMap.get(entry.entry.id);
    if (!existing || entry.score > existing.score) {
      entryMap.set(entry.entry.id, entry);
    }
  }
  return Array.from(entryMap.values());
}

function hasRetrievalMatch(item: RetrievedMemoryEntry) {
  return item.matchReason.some((reason) =>
    /^(project|projectAnchor|topic|askFrame|title|tags|keywords|content):/.test(reason)
  );
}

function hasRequiredTaggedHints(
  entry: MemoryEntry,
  query: string
) {
  const normalizedQuery = query.toLowerCase();
  const companyTags = entry.tags
    .map((tag) => tag.toLowerCase())
    .filter((tag) => tag.startsWith("company:"))
    .map((tag) => tag.slice("company:".length).trim())
    .filter(Boolean);

  if (
    companyTags.length &&
    !companyTags.some((company) =>
      normalizedQuery.includes(`company:${company}`)
    )
  ) {
    return false;
  }

  const lpTags = entry.tags
    .map((tag) => tag.toLowerCase())
    .filter((tag) => tag.startsWith("lp:"))
    .map((tag) => tag.slice("lp:".length).trim())
    .filter(Boolean);

  if (!lpTags.length) return true;

  return lpTags.some((principle) =>
    normalizedQuery.includes(`lp:${principle}`)
  );
}

function countTokenOverlap(left: Set<string>, right: Set<string>) {
  let count = 0;
  for (const token of right) {
    if (left.has(token)) count += 1;
  }
  return count;
}

function tokenize(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  return new Set(normalized.split(" ").filter((token) => token.length >= 2));
}

function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n[truncated]`;
}
