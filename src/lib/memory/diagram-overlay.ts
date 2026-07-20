import type {
  DiagramOverlayDomainFamily,
  MemoryEntry,
  MemoryQuestionType,
  MemoryRejectReason,
  MemoryTopicDomain,
} from "./types";

const DIAGRAM_FAMILY_SIGNALS: Record<
  DiagramOverlayDomainFamily,
  Array<{ label: string; pattern: RegExp }>
> = {
  "geo-matching": [
    { label: "uber", pattern: /\buber(?:-like)?\b/i },
    { label: "ride", pattern: /\b(?:ride|rides|driver|drivers|rider|riders)\b/i },
    { label: "location", pattern: /\b(?:geo|geospatial|location|gps|nearby)\b/i },
  ],
  "scarce-inventory": [
    { label: "ticket", pattern: /\b(?:ticket|ticketing|seat|seats)\b/i },
    { label: "booking", pattern: /\b(?:booking|reservation|reserve)\b/i },
    { label: "inventory", pattern: /\b(?:inventory|scarce inventory|double-booking)\b/i },
  ],
  "feed-fanout": [
    { label: "feed", pattern: /\b(?:news feed|social feed|feed|timeline)\b/i },
    { label: "fanout", pattern: /\b(?:fanout|fan-out|followers?|following)\b/i },
    { label: "social", pattern: /\b(?:instagram|twitter|social network)\b/i },
  ],
  "rag-app": [
    { label: "rag", pattern: /\b(?:rag|retrieval[- ]augmented generation)\b/i },
    { label: "grounded-generation", pattern: /\b(?:grounded generation|groundedness|citation verifier)\b/i },
  ],
  "retrieval-ranking": [
    { label: "ranking", pattern: /\b(?:ranking|ranker|rerank|reranker)\b/i },
    { label: "recommendation", pattern: /\b(?:recommendation|recommender|candidate generation)\b/i },
    { label: "search", pattern: /\b(?:search system|semantic search|retrieval system|retrieval pipeline)\b/i },
  ],
  "real-time-ml": [
    { label: "ml-system", pattern: /\b(?:ml system design|machine learning system)\b/i },
    { label: "feature-path", pattern: /\b(?:feature store|feature parity|feature generation)\b/i },
    { label: "model-lifecycle", pattern: /\b(?:model training|model serving|model registry|retraining|drift)\b/i },
  ],
  "llmops-pipeline": [
    { label: "llmops", pattern: /\b(?:llmops|llm ops|model gateway|model routing)\b/i },
  ],
  "agent-runtime": [
    { label: "agent-runtime", pattern: /\b(?:agent runtime|agentic system|tool execution|planner executor|agent memory)\b/i },
  ],
};

export interface DiagramOverlayDomainGateResult {
  allowedEntryIds: string[];
  rejected: Array<{
    entryId: string;
    reason: MemoryRejectReason;
    actualFamilies: DiagramOverlayDomainFamily[];
  }>;
  context: {
    allowedFamilies: DiagramOverlayDomainFamily[];
    evidence: string[];
  };
}

export function isDiagramOverlayMemoryEntry(entry: Pick<MemoryEntry, "type">) {
  return (
    entry.type === "architecture_diagram" ||
    entry.type === "whiteboard_overlay"
  );
}

export function getDiagramOverlayGateRejectReason(
  entry: Pick<MemoryEntry, "type">,
  questionType: MemoryQuestionType | undefined,
  query: string
): MemoryRejectReason | undefined {
  if (!isDiagramOverlayMemoryEntry(entry)) return undefined;

  if (
    questionType === "general-system-design" ||
    questionType === "system-design" ||
    questionType === "ai-ml-system-design"
  ) {
    return undefined;
  }

  if (
    (questionType === "project-deep-dive" || questionType === "field-knowledge") &&
    isArchitectureStyleQuery(query)
  ) {
    return undefined;
  }

  return "diagram-overlay-question-type-blocked";
}

export function gateDiagramOverlayEntriesByDomain(
  entries: MemoryEntry[],
  {
    query,
    questionType,
    topicDomain,
  }: {
    query: string;
    questionType?: MemoryQuestionType;
    topicDomain?: MemoryTopicDomain;
  }
): DiagramOverlayDomainGateResult {
  const context = resolveDiagramOverlayDomainContext(query, topicDomain);
  const allowedEntryIds: string[] = [];
  const rejected: DiagramOverlayDomainGateResult["rejected"] = [];

  for (const entry of entries) {
    if (!isDiagramOverlayMemoryEntry(entry)) continue;

    const questionTypeReason = getDiagramOverlayGateRejectReason(
      entry,
      questionType,
      query
    );
    const actualFamilies = inferDiagramOverlayEntryFamilies(entry);
    if (questionTypeReason) {
      rejected.push({
        entryId: entry.id,
        reason: questionTypeReason,
        actualFamilies,
      });
      continue;
    }

    const matchesAllowedFamily = actualFamilies.some((family) =>
      context.allowedFamilies.includes(family)
    );
    if (!context.allowedFamilies.length || !matchesAllowedFamily) {
      rejected.push({
        entryId: entry.id,
        reason: "diagram-overlay-domain-blocked",
        actualFamilies,
      });
      continue;
    }

    allowedEntryIds.push(entry.id);
  }

  return { allowedEntryIds, rejected, context };
}

export function inferDiagramOverlayEntryFamilies(
  entry: Pick<
    MemoryEntry,
    "id" | "title" | "tags" | "keywords" | "summary" | "content"
  >
) {
  const primarySearchable = [
    entry.id,
    entry.title,
    entry.tags.join(" "),
    entry.keywords.join(" "),
    entry.summary,
  ]
    .filter(Boolean)
    .join(" ");

  const primaryFamilies = resolveFamiliesFromText(primarySearchable).families;
  if (primaryFamilies.length) {
    return [selectPrimaryEntryFamily(primaryFamilies)];
  }

  const contentFamilies = resolveFamiliesFromText(entry.content).families;
  return contentFamilies.length
    ? [selectPrimaryEntryFamily(contentFamilies)]
    : [];
}

function resolveDiagramOverlayDomainContext(
  query: string,
  topicDomain: MemoryTopicDomain | undefined
) {
  const resolved = resolveFamiliesFromText(query);
  const allowedFamilies = new Set(resolved.families);
  const evidence = [...resolved.evidence];

  if (topicDomain === "search") {
    allowedFamilies.add("retrieval-ranking");
    evidence.push("topic-domain:search");
  }
  if (isArchitectureStyleQuery(query)) {
    evidence.push("query:architecture-intent");
  }

  return {
    allowedFamilies: Array.from(allowedFamilies).sort(),
    evidence: Array.from(new Set(evidence)).sort(),
  };
}

function selectPrimaryEntryFamily(families: DiagramOverlayDomainFamily[]) {
  const precedence: DiagramOverlayDomainFamily[] = [
    "rag-app",
    "geo-matching",
    "scarce-inventory",
    "feed-fanout",
    "real-time-ml",
    "llmops-pipeline",
    "agent-runtime",
    "retrieval-ranking",
  ];
  return precedence.find((family) => families.includes(family)) ?? families[0];
}

function resolveFamiliesFromText(text: string) {
  const families: DiagramOverlayDomainFamily[] = [];
  const evidence: string[] = [];

  for (const [family, signals] of Object.entries(DIAGRAM_FAMILY_SIGNALS) as Array<
    [DiagramOverlayDomainFamily, (typeof DIAGRAM_FAMILY_SIGNALS)[DiagramOverlayDomainFamily]]
  >) {
    for (const signal of signals) {
      if (!signal.pattern.test(text)) continue;
      families.push(family);
      evidence.push(`query:${family}:${signal.label}`);
      break;
    }
  }

  return {
    families: Array.from(new Set(families)).sort(),
    evidence: Array.from(new Set(evidence)).sort(),
  };
}

function isArchitectureStyleQuery(query: string) {
  return /\b(architecture|diagram|whiteboard|pipeline|flow|layers?|components?|system design|infra|infrastructure|data path|serving path|retrieval path|write path|read path|draw|write it down|explain the layers)\b/i.test(
    query
  );
}
