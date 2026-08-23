import type {
  AdvisorCurrentQuestionEvidence,
  AdvisorEvidencePacket,
  AdvisorGeneratedContinuityEvidence,
  AdvisorGeneratedGuidanceEvidence,
  AdvisorPersonalizedPreparationEvidence,
  AdvisorRetrievalHint,
  AdvisorRetrievalHintRole,
  AdvisorSourceOwnedSemanticContext,
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
  sourceOwnedSemanticContext?: AdvisorSourceOwnedSemanticContext;
  activeMeetingTask?: ActiveMeetingTask;
  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
  preparationRuntimeBrief?: PreparationRuntimeBrief;
  preferredProgrammingLanguage?: string;
  personalizedGuidance?: AdvisorPersonalizedPreparationEvidence;
  activatedFactIds?: string[];
  generatedGuidance?: AdvisorGeneratedGuidanceEvidence;
  generatedContinuity?: AdvisorGeneratedContinuityEvidence;
  additionalRetrievalHints?: AdvisorRetrievalHint[];
}

export function buildAdvisorEvidencePacket(
  input: BuildAdvisorEvidencePacketInput
): AdvisorEvidencePacket {
  const currentQuestion = normalizeCurrentQuestion(input.currentQuestion);
  const sourceOwnedSemanticContext = normalizeSourceOwnedSemanticContext(
    input.sourceOwnedSemanticContext
  );
  const continuity = buildContinuityEvidence(input.activeMeetingTask);
  const guidanceHints = uniqueStrings([
    ...(input.preparationRuntimeBrief?.focusAreas ?? []).map((value) =>
      boundText(value, MAX_GUIDANCE_HINT_CHARS)
    ),
    ...(input.preparationRuntimeBrief?.compactNotes ?? []).map((value) =>
      boundText(value, MAX_GUIDANCE_HINT_CHARS)
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
    sourceOwnedSemanticContext,
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
      personalizedGuidance: normalizePersonalizedGuidance(
        input.personalizedGuidance
      ),
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
          packet.currentQuestion.sourceHash
            ? `source_hash: ${packet.currentQuestion.sourceHash}`
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
    "<source_owned_semantic_context>",
    packet.sourceOwnedSemanticContext
      ? [
          "Authority: this is source-owned setup for interpreting the current question only. It may clarify an object, constraint, or tradeoff, but cannot create another ask or authorize task, phase, memory, or artifact mutation.",
          `text: ${packet.sourceOwnedSemanticContext.text}`,
        ].join("\n")
      : "No adjacent source-owned setup context.",
    "</source_owned_semantic_context>",
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
    "<personalized_preparation>",
    formatPersonalizedGuidance(
      packet.preparation.personalizedGuidance
    ),
    "</personalized_preparation>",
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

  const personalized = packet.preparation.personalizedGuidance;
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
    promptCurrentQuestionSourceHash:
      packet.currentQuestion?.sourceHash,
    currentQuestionScreenObservationId:
      packet.currentQuestion?.screenObservationId,
    sourceOwnedSemanticContextPresent: Boolean(
      packet.sourceOwnedSemanticContext
    ),
    sourceOwnedSemanticContextChars:
      packet.sourceOwnedSemanticContext?.text.length ?? 0,
    sourceOwnedSemanticContextTurnIds:
      packet.sourceOwnedSemanticContext?.sourceTurnIds ?? [],
    sourceOwnedSemanticContextParentId:
      packet.sourceOwnedSemanticContext?.parentId,
    sourceOwnedSemanticContextParentRevision:
      packet.sourceOwnedSemanticContext?.parentRevision,
    sourceOwnedSemanticContextRetentionReason:
      packet.sourceOwnedSemanticContext?.retentionReason,
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
    preparationPersonalizedGuidancePresent: Boolean(personalized),
    preparationStrategyCategories:
      personalized?.strategy
        ? Object.entries(personalized.strategy)
            .filter(([, values]) => Boolean(values?.length))
            .map(([category]) => category)
        : [],
    preparationFactEvidenceCount:
      personalized?.factEvidence.length ?? 0,
    preparationOpeningItemCount:
      personalized?.openingItems.length ?? 0,
    preparationNarrativeGraphCount:
      personalized?.narratives.length ?? 0,
    preparationNarrativeNodeCount:
      personalized?.narratives.reduce(
        (total, graph) => total + graph.nodes.length,
        0
      ) ?? 0,
    preparationPlaybookOverlayId:
      personalized?.playbookOverlay?.canonicalPlaybookId,
    preparationPlaybookOverlayFamily:
      personalized?.playbookOverlay?.expectedInterviewType,
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

function normalizePersonalizedGuidance(
  guidance: AdvisorPersonalizedPreparationEvidence | undefined
): AdvisorPersonalizedPreparationEvidence | undefined {
  if (!guidance) return undefined;
  return {
    strategy: guidance.strategy
      ? Object.fromEntries(
          Object.entries(guidance.strategy).map(([key, values]) => [
            key,
            uniqueStrings(values ?? []).map((value) =>
              boundText(value, MAX_GUIDANCE_HINT_CHARS)
            ),
          ])
        )
      : undefined,
    factEvidence: guidance.factEvidence.slice(0, 6).map((item) => ({
      ...item,
      content: boundText(item.content, 1_200) ?? "",
      allowedWording: boundText(item.allowedWording, 600),
      prohibitedWording: uniqueStrings(item.prohibitedWording)
        .slice(0, 6)
        .map((value) => boundText(value, 300) ?? "")
        .filter(Boolean),
      sourceIds: uniqueStrings(item.sourceIds).slice(0, 8),
    })),
    openingItems: guidance.openingItems.slice(0, 2).map((item) => ({
      ...item,
      renderedDraft: boundText(item.renderedDraft, 1_800) ?? "",
      statementIds: uniqueStrings(item.statementIds).slice(0, 12),
    })),
    narratives: guidance.narratives.slice(0, 1).map((graph) => ({
      ...graph,
      nodes: graph.nodes.slice(0, 4).map((node) => ({
        ...node,
        content: boundText(node.content, 1_200) ?? "",
        statementIds: uniqueStrings(node.statementIds).slice(0, 12),
      })),
    })),
    playbookOverlay: guidance.playbookOverlay
      ? {
          ...guidance.playbookOverlay,
          evidenceStatementIds: uniqueStrings(
            guidance.playbookOverlay.evidenceStatementIds
          ).slice(0, 16),
          companyCriteria: uniqueStrings(
            guidance.playbookOverlay.companyCriteria
          )
            .slice(0, 6)
            .map((value) => boundText(value, 500) ?? "")
            .filter(Boolean),
          prohibitedOverclaims: uniqueStrings(
            guidance.playbookOverlay.prohibitedOverclaims
          )
            .slice(0, 8)
            .map((value) => boundText(value, 300) ?? "")
            .filter(Boolean),
        }
      : undefined,
  };
}

function formatPersonalizedGuidance(
  guidance: AdvisorPersonalizedPreparationEvidence | undefined
) {
  if (!guidance) return "No personalized preparation guidance.";
  const strategy = guidance.strategy
    ? Object.entries(guidance.strategy).flatMap(([category, values]) =>
        (values ?? []).map(
          (value) => `strategy ${category}: ${value}`
        )
      )
    : [];
  const facts = guidance.factEvidence.map((item) =>
    [
      `fact id=${item.statementId} ownership=${item.ownership}`,
      `content: ${item.content}`,
      item.allowedWording
        ? `allowed wording: ${item.allowedWording}`
        : undefined,
      item.prohibitedWording.length
        ? `prohibited wording: ${item.prohibitedWording.join(" | ")}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n")
  );
  const openings = guidance.openingItems.map(
    (item) =>
      `opening ${item.nodeKind} subject=${item.subjectId} statement_ids=${item.statementIds.join(",")}:\n${item.renderedDraft}`
  );
  const narratives = guidance.narratives.flatMap((graph) =>
    graph.nodes.map(
      (node) =>
        `narrative ${node.kind} subject=${graph.subjectId} statement_ids=${node.statementIds.join(",")}:\n${node.content}`
    )
  );
  const overlay = guidance.playbookOverlay
    ? [
        `playbook overlay id=${guidance.playbookOverlay.canonicalPlaybookId} family=${guidance.playbookOverlay.expectedInterviewType}`,
        ...guidance.playbookOverlay.companyCriteria.map(
          (value) => `company criterion: ${value}`
        ),
        ...guidance.playbookOverlay.prohibitedOverclaims.map(
          (value) => `prohibited overclaim: ${value}`
        ),
      ]
    : [];
  return [
    "Authority: strategy and playbook overlays guide framing only. They cannot create facts, mutate the task, or advance the playbook phase.",
    "Fact evidence may support first-person wording only when the fact-anchor guardrail lists its statement id. Respect ownership and prohibited wording.",
    "Opening and narrative drafts are reviewed answer material for the matched subject only; do not transfer them to another project or task.",
    ...strategy,
    ...facts,
    ...openings,
    ...narratives,
    ...overlay,
  ].join("\n");
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

function normalizeSourceOwnedSemanticContext(
  context: AdvisorSourceOwnedSemanticContext | undefined
): AdvisorSourceOwnedSemanticContext | undefined {
  if (!context) return undefined;
  const text = boundText(context.text, 600);
  const parentId = cleanText(context.parentId);
  const sourceTurnIds = uniqueStrings(context.sourceTurnIds);
  if (!text || !parentId || !sourceTurnIds.length) return undefined;
  return {
    text,
    sourceTurnIds,
    parentId,
    parentRevision: context.parentRevision,
    retentionReason: "same-parent-adjacent-setup",
  };
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
