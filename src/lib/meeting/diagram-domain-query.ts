import type {
  EffectiveInterviewTaskRelation,
  InterviewTaskRelation,
} from "./types";

export type DiagramDomainEvidenceSource =
  | "current-question"
  | "active-parent-topic"
  | "capture-title-fallback";

export interface DiagramDomainQueryContext {
  query: string;
  evidenceSources: DiagramDomainEvidenceSource[];
  parentTopicIncluded: boolean;
}

const CONTINUITY_RELATIONS = new Set<
  InterviewTaskRelation | EffectiveInterviewTaskRelation
>([
  "followup-parent",
  "child-probe",
  "resume-parent",
]);

const MAX_DIAGRAM_DOMAIN_QUERY_CHARS = 1200;

export function buildCurrentTaskDiagramDomainContext({
  currentQuestion,
  parentTopic,
  relation,
  captureTitleFallback,
}: {
  currentQuestion?: string;
  parentTopic?: string;
  relation: InterviewTaskRelation | EffectiveInterviewTaskRelation;
  captureTitleFallback?: string;
}): DiagramDomainQueryContext {
  const question = normalizeEvidence(currentQuestion);
  const parent = normalizeEvidence(parentTopic);
  const captureTitle = normalizeEvidence(captureTitleFallback);
  const includeParent = Boolean(
    parent && CONTINUITY_RELATIONS.has(relation)
  );
  const evidence: Array<{
    source: DiagramDomainEvidenceSource;
    value: string;
  }> = [];

  if (includeParent) {
    evidence.push({ source: "active-parent-topic", value: parent });
  }
  if (question) {
    evidence.push({ source: "current-question", value: question });
  } else if (!includeParent && captureTitle) {
    evidence.push({
      source: "capture-title-fallback",
      value: captureTitle,
    });
  }

  const deduped = evidence.filter(
    (item, index, items) =>
      items.findIndex(
        (candidate) => candidate.value.toLowerCase() === item.value.toLowerCase()
      ) === index
  );

  return {
    query: deduped
      .map((item) => item.value)
      .join("\n")
      .slice(0, MAX_DIAGRAM_DOMAIN_QUERY_CHARS),
    evidenceSources: deduped.map((item) => item.source),
    parentTopicIncluded: deduped.some(
      (item) => item.source === "active-parent-topic"
    ),
  };
}

function normalizeEvidence(value: string | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}
