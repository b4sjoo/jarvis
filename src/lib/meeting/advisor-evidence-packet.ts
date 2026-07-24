import type {
  AdvisorCurrentQuestionEvidence,
  AdvisorEvidencePacket,
  AdvisorGeneratedGuidanceEvidence,
  AdvisorRetrievalHint,
  AdvisorRetrievalHintRole,
  InterviewSessionBrief,
  InterviewSessionContext,
} from "./types.js";
import type { ActiveMeetingTask } from "./active-meeting-task.js";

const MAX_CURRENT_QUESTION_CHARS = 4_000;
const MAX_GUIDANCE_HINT_CHARS = 800;
const MAX_CONTINUITY_CAPSULE_CHARS = 1_200;
const MAX_GENERATED_GUIDANCE_CHARS = 2_000;
const MAX_RETRIEVAL_QUERY_CHARS = 8_000;

export interface BuildAdvisorEvidencePacketInput {
  currentQuestion?: AdvisorCurrentQuestionEvidence;
  activeMeetingTask?: ActiveMeetingTask;
  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
  activatedFactIds?: string[];
  generatedGuidance?: AdvisorGeneratedGuidanceEvidence;
  additionalRetrievalHints?: AdvisorRetrievalHint[];
}

export function buildAdvisorEvidencePacket(
  input: BuildAdvisorEvidencePacketInput
): AdvisorEvidencePacket {
  const currentQuestion = normalizeCurrentQuestion(input.currentQuestion);
  const continuity = buildContinuityEvidence(input.activeMeetingTask);
  const guidanceHints = uniqueStrings([
    boundText(
      input.interviewSessionBrief?.focusAreas,
      MAX_GUIDANCE_HINT_CHARS
    ),
    boundText(
      input.interviewSessionBrief?.notes,
      MAX_GUIDANCE_HINT_CHARS
    ),
  ]);
  const targetCompany =
    cleanText(input.interviewSessionBrief?.targetCompany) ??
    cleanText(input.interviewSessionContext?.targetCompany?.value);
  const interviewTypes = Array.from(
    new Set(input.interviewSessionBrief?.interviewTypes ?? [])
  );
  const activatedFactIds = uniqueStrings(input.activatedFactIds ?? []);
  const generatedGuidance = normalizeGeneratedGuidance(
    input.generatedGuidance
  );

  const retrievalHints = uniqueRetrievalHints([
    targetCompany
      ? {
          role: "company-prior",
          text: `target company: ${targetCompany}`,
        }
      : undefined,
    interviewTypes.length
      ? {
          role: "interview-type-prior",
          text: `interview types: ${interviewTypes.join(", ")}`,
        }
      : undefined,
    ...guidanceHints.map((text) => ({
      role: "preparation-guidance" as const,
      text,
    })),
    continuity?.capsule
      ? {
          role: "continuity",
          text: continuity.capsule,
        }
      : undefined,
    ...(input.additionalRetrievalHints ?? []),
  ]);

  return {
    version: "advisor-evidence-v1",
    currentQuestion,
    continuity,
    preparation: {
      targetCompany,
      interviewTypes,
      guidanceHints,
      activatedFactIds,
      rawGuidanceRejectedAsFactCount: guidanceHints.length,
    },
    generatedGuidance,
    retrievalHints,
  };
}

export function getCurrentQuestionEvidenceText(
  packet: AdvisorEvidencePacket | undefined
) {
  return packet?.currentQuestion?.text ?? "";
}

export function buildAdvisorEvidenceRetrievalQuery(
  packet: AdvisorEvidencePacket,
  mode: string
) {
  return [
    `mode: ${cleanText(mode) ?? "unknown"}`,
    packet.currentQuestion?.text
      ? `current-question:\n${packet.currentQuestion.text}`
      : undefined,
    ...packet.retrievalHints.map(
      (hint) => `retrieval-hint[${hint.role}]:\n${hint.text}`
    ),
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(-MAX_RETRIEVAL_QUERY_CHARS);
}

export function formatAdvisorEvidencePacketForPrompt(
  packet: AdvisorEvidencePacket | undefined
) {
  if (!packet) return "No typed advisor evidence packet.";

  return [
    "Authority rule: only current_question can create a personal-evidence requirement or establish what is being asked.",
    "Preparation and continuity can guide retrieval or answer framing, but are not current-question evidence.",
    "Generated guidance is continuity-only and is never factual evidence.",
    "<current_question>",
    packet.currentQuestion
      ? [
          `source: ${packet.currentQuestion.source}`,
          packet.currentQuestion.logicalQuestionUnitId
            ? `logical_question_unit_id: ${packet.currentQuestion.logicalQuestionUnitId}`
            : undefined,
          typeof packet.currentQuestion.revision === "number"
            ? `revision: ${packet.currentQuestion.revision}`
            : undefined,
          packet.currentQuestion.screenObservationId
            ? `screen_observation_id: ${packet.currentQuestion.screenObservationId}`
            : undefined,
          `text: ${packet.currentQuestion.text}`,
        ]
          .filter(Boolean)
          .join("\n")
      : "No authoritative current-question evidence.",
    "</current_question>",
    "<continuity>",
    packet.continuity?.capsule || "No continuity capsule.",
    "</continuity>",
    "<preparation_guidance>",
    [
      packet.preparation.targetCompany
        ? `target company: ${packet.preparation.targetCompany}`
        : undefined,
      packet.preparation.interviewTypes.length
        ? `interview types: ${packet.preparation.interviewTypes.join(", ")}`
        : undefined,
      ...packet.preparation.guidanceHints.map(
        (hint) => `guidance only: ${hint}`
      ),
      packet.preparation.activatedFactIds.length
        ? `explicitly activated fact ids: ${packet.preparation.activatedFactIds.join(", ")}`
        : "explicitly activated fact ids: none",
    ]
      .filter(Boolean)
      .join("\n") || "No preparation guidance.",
    "</preparation_guidance>",
    "<generated_guidance>",
    packet.generatedGuidance
      ? `source trace: ${packet.generatedGuidance.sourceTraceId}\ncontinuity only: ${packet.generatedGuidance.text}`
      : "No generated guidance.",
    "</generated_guidance>",
  ].join("\n");
}

export function formatAdvisorEvidencePacketForTrace(
  packet: AdvisorEvidencePacket | undefined,
  retrievalQuery?: string
): Record<string, unknown> {
  if (!packet) return {};

  const roleCounts = packet.retrievalHints.reduce<Record<string, number>>(
    (counts, hint) => {
      counts[hint.role] = (counts[hint.role] ?? 0) + 1;
      return counts;
    },
    {}
  );

  return {
    advisorEvidencePacketVersion: packet.version,
    currentQuestionEvidenceSource: packet.currentQuestion?.source,
    currentQuestionEvidenceChars:
      packet.currentQuestion?.text.length ?? 0,
    currentQuestionSourceTurnIds:
      packet.currentQuestion?.sourceTurnIds ?? [],
    currentQuestionLogicalQuestionUnitId:
      packet.currentQuestion?.logicalQuestionUnitId,
    currentQuestionLogicalQuestionRevision:
      packet.currentQuestion?.revision,
    currentQuestionScreenObservationId:
      packet.currentQuestion?.screenObservationId,
    continuityParentTaskId: packet.continuity?.parentTaskId,
    continuityChildTaskId: packet.continuity?.childTaskId,
    continuityCapsuleChars: packet.continuity?.capsule?.length ?? 0,
    preparationTargetCompanyPresent: Boolean(
      packet.preparation.targetCompany
    ),
    preparationInterviewTypes: packet.preparation.interviewTypes,
    preparationGuidanceHintCount:
      packet.preparation.guidanceHints.length,
    preparationGuidanceChars: packet.preparation.guidanceHints.reduce(
      (total, hint) => total + hint.length,
      0
    ),
    preparationActivatedFactCount:
      packet.preparation.activatedFactIds.length,
    rejectedRawBriefFactAnchorCount:
      packet.preparation.rawGuidanceRejectedAsFactCount,
    generatedGuidancePresent: Boolean(packet.generatedGuidance),
    generatedGuidanceChars:
      packet.generatedGuidance?.text.length ?? 0,
    generatedGuidanceSourceTraceId:
      packet.generatedGuidance?.sourceTraceId,
    retrievalHintRoleCounts: roleCounts,
    retrievalHintCount: packet.retrievalHints.length,
    retrievalQueryChars: retrievalQuery?.length ?? 0,
  };
}

function normalizeCurrentQuestion(
  question: AdvisorCurrentQuestionEvidence | undefined
) {
  if (!question) return undefined;
  const text = boundText(question.text, MAX_CURRENT_QUESTION_CHARS);
  if (!text) return undefined;

  return {
    ...question,
    text,
    sourceTurnIds: uniqueStrings(question.sourceTurnIds),
  };
}

function buildContinuityEvidence(
  task: ActiveMeetingTask | undefined
) {
  if (!task) return undefined;
  const capsule = [
    `parent task: ${task.parent.topic}`,
    `parent type: ${task.parent.questionType}`,
    `playbook phase: ${task.parent.playbookPhase}`,
    task.child
      ? `active child: ${task.child.questionType} / ${task.child.intent} / ${task.child.question}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_CONTINUITY_CAPSULE_CHARS);

  return {
    parentTaskId: task.parent.id,
    childTaskId: task.child?.id,
    capsule,
    sourceTurnIds: uniqueStrings(
      task.parent.canonicalQuestionSourceTurnIds ?? []
    ),
  };
}

function normalizeGeneratedGuidance(
  guidance: AdvisorGeneratedGuidanceEvidence | undefined
) {
  if (!guidance) return undefined;
  const text = boundText(
    guidance.text,
    MAX_GENERATED_GUIDANCE_CHARS
  );
  const sourceTraceId = cleanText(guidance.sourceTraceId);
  if (!text || !sourceTraceId) return undefined;
  return { text, sourceTraceId };
}

function uniqueRetrievalHints(
  values: Array<AdvisorRetrievalHint | undefined>
) {
  const seen = new Set<string>();
  const result: AdvisorRetrievalHint[] = [];
  for (const value of values) {
    if (!value) continue;
    const role = value.role as AdvisorRetrievalHintRole;
    const text = boundText(value.text, MAX_GUIDANCE_HINT_CHARS);
    if (!text) continue;
    const key = `${role}:${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ role, text });
  }
  return result;
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(
    new Set(values.map(cleanText).filter((value): value is string => Boolean(value)))
  );
}

function cleanText(value: string | undefined) {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function boundText(value: string | undefined, maxChars: number) {
  const normalized = cleanText(value);
  return normalized?.slice(0, maxChars);
}
