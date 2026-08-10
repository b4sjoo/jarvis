import type {
  AdvisorCurrentQuestionEvidence,
  AdvisorEvidencePacket,
  AdvisorGeneratedContinuityEvidence,
  AdvisorGeneratedGuidanceEvidence,
  AdvisorRetrievalHint,
  AdvisorRetrievalHintRole,
  InterviewSessionBrief,
  InterviewSessionContext,
} from "./types.js";
import type { ActiveMeetingTask } from "./active-meeting-task.js";
import type { PreparationRuntimeBrief } from "../preparation/index.js";

const MAX_CURRENT_QUESTION_CHARS = 4_000;
const MAX_GUIDANCE_HINT_CHARS = 800;
const MAX_CONTINUITY_CAPSULE_CHARS = 1_200;
const MAX_GENERATED_GUIDANCE_CHARS = 2_000;
const MAX_GENERATED_CONTINUITY_CAPSULE_CHARS = 520;
const MAX_RETRIEVAL_QUERY_CHARS = 8_000;

export interface BuildAdvisorEvidencePacketInput {
  currentQuestion?: AdvisorCurrentQuestionEvidence;
  activeMeetingTask?: ActiveMeetingTask;
  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
  preparationRuntimeBrief?: PreparationRuntimeBrief;
  preferredProgrammingLanguage?: string;
  activatedFactIds?: string[];
  generatedGuidance?: AdvisorGeneratedGuidanceEvidence;
  generatedContinuity?: AdvisorGeneratedContinuityEvidence;
  additionalRetrievalHints?: AdvisorRetrievalHint[];
}

export function buildAdvisorEvidencePacket(
  input: BuildAdvisorEvidencePacketInput
): AdvisorEvidencePacket {
  const currentQuestion = normalizeCurrentQuestion(input.currentQuestion);
  const continuity = buildContinuityEvidence(input.activeMeetingTask);
  const guidanceHints = uniqueStrings([
    ...(input.preparationRuntimeBrief?.focusAreas ?? []).map((value) =>
      boundText(value, MAX_GUIDANCE_HINT_CHARS)
    ),
    ...(input.preparationRuntimeBrief?.compactNotes ?? []).map((value) =>
      boundText(value, MAX_GUIDANCE_HINT_CHARS)
    ),
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
    cleanText(input.preparationRuntimeBrief?.company) ??
    cleanText(input.interviewSessionBrief?.targetCompany) ??
    cleanText(input.interviewSessionContext?.targetCompany?.value);
  const interviewTypes = Array.from(
    new Set(input.interviewSessionBrief?.interviewTypes ?? [])
  );
  const activatedFactIds = uniqueStrings(input.activatedFactIds ?? []);
  const generatedGuidance = normalizeGeneratedGuidance(
    input.generatedGuidance
  );
  const generatedContinuity = normalizeGeneratedContinuity(
    input.generatedContinuity
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
    version: "advisor-evidence-v2",
    currentQuestion,
    continuity,
    preparation: {
      targetCompany,
      interviewTypes,
      runtimeBrief: input.preparationRuntimeBrief
        ? normalizeRuntimeBrief(input.preparationRuntimeBrief)
        : undefined,
      preferredProgrammingLanguage:
        cleanText(input.preferredProgrammingLanguage) ??
        cleanText(
          input.preparationRuntimeBrief?.preferredProgrammingLanguage
        ),
      guidanceHints,
      activatedFactIds,
      rawGuidanceRejectedAsFactCount: guidanceHints.length,
    },
    generatedGuidance,
    generatedContinuity,
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
    "Generated continuity is a bounded model-output reference. It can resolve a deictic follow-up, but cannot establish facts, personal history, task relation, parent, playbook phase, memory truth, or artifact mutation authority.",
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
      packet.preparation.runtimeBrief?.role
        ? `target role: ${packet.preparation.runtimeBrief.role}`
        : undefined,
      packet.preparation.runtimeBrief?.roundTitle
        ? `round: ${packet.preparation.runtimeBrief.roundTitle}`
        : undefined,
      packet.preparation.runtimeBrief?.stage
        ? `round stage: ${packet.preparation.runtimeBrief.stage}`
        : undefined,
      packet.preparation.interviewTypes.length
        ? `interview types: ${packet.preparation.interviewTypes.join(", ")}`
        : undefined,
      packet.preparation.preferredProgrammingLanguage
        ? `preferred programming language: ${packet.preparation.preferredProgrammingLanguage}`
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
    "<generated_continuity>",
    packet.generatedContinuity
      ? [
          `context read scope: ${packet.generatedContinuity.contextReadScope}`,
          `decision reason: ${packet.generatedContinuity.decisionReason}`,
          `parent task id: ${packet.generatedContinuity.parentTaskId}`,
          packet.generatedContinuity.deicticEvidence.length
            ? `deictic evidence: ${packet.generatedContinuity.deicticEvidence.join(", ")}`
            : "deictic evidence: explicit context expansion",
          "Authority: generated continuity only. Do not treat any capsule as source-owned fact or use it to mutate task state, relation, phase, memory, code, complexity, or whiteboard.",
          ...packet.generatedContinuity.capsules.map(
            (capsule, index) =>
              `capsule ${index + 1} [answer revision ${capsule.answerRevision}, source suggestion ${capsule.sourceSuggestionId}]:\n${capsule.text}`
          ),
        ].join("\n")
      : "No generated continuity.",
    "</generated_continuity>",
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
    generatedContinuityPresent: Boolean(packet.generatedContinuity),
    generatedContinuityContextReadScope:
      packet.generatedContinuity?.contextReadScope,
    generatedContinuityDecisionReason:
      packet.generatedContinuity?.decisionReason,
    generatedContinuityParentTaskId:
      packet.generatedContinuity?.parentTaskId,
    generatedContinuityCapsuleCount:
      packet.generatedContinuity?.capsules.length ?? 0,
    generatedContinuityChars:
      packet.generatedContinuity?.capsules.reduce(
        (total, capsule) => total + capsule.text.length,
        0
      ) ?? 0,
    generatedContinuitySourceTraceCount: new Set(
      packet.generatedContinuity?.capsules
        .map((capsule) => capsule.sourceTraceId)
        .filter(Boolean) ?? []
    ).size,
    generatedContinuityExcludedFromRetrieval: true,
    generatedContinuityAuthority: "continuity-only",
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

function normalizeRuntimeBrief(
  brief: PreparationRuntimeBrief
): PreparationRuntimeBrief {
  return {
    ...brief,
    expectedInterviewTypes: [...brief.expectedInterviewTypes],
    focusAreas: uniqueStrings(brief.focusAreas),
    compactNotes: uniqueStrings(brief.compactNotes),
    unresolvedHighImpactAssumptions: uniqueStrings(
      brief.unresolvedHighImpactAssumptions
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

function normalizeGeneratedContinuity(
  evidence: AdvisorGeneratedContinuityEvidence | undefined
): AdvisorGeneratedContinuityEvidence | undefined {
  if (
    !evidence ||
    evidence.contextReadScope !== "bounded-recent-history"
  ) {
    return undefined;
  }
  const parentTaskId = cleanText(evidence.parentTaskId);
  const decisionReason = cleanText(evidence.decisionReason);
  if (!parentTaskId || !decisionReason) return undefined;

  const capsules = evidence.capsules
    .map((capsule) => ({
      ...capsule,
      parentTaskId: cleanText(capsule.parentTaskId) ?? "",
      sourceSuggestionId:
        cleanText(capsule.sourceSuggestionId) ?? "",
      sourceTraceId: cleanText(capsule.sourceTraceId),
      text:
        boundText(
          capsule.text,
          MAX_GENERATED_CONTINUITY_CAPSULE_CHARS
        ) ?? "",
    }))
    .filter(
      (capsule) =>
        capsule.parentTaskId === parentTaskId &&
        Boolean(capsule.sourceSuggestionId) &&
        Boolean(capsule.text)
    )
    .slice(-2);
  if (!capsules.length) return undefined;

  return {
    contextReadScope: "bounded-recent-history",
    decisionReason,
    parentTaskId,
    deicticEvidence: uniqueStrings(evidence.deicticEvidence),
    capsules,
  };
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
