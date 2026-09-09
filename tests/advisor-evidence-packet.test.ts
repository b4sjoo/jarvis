import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAdvisorEvidencePacket,
  buildAdvisorEvidenceRetrievalQuery,
  formatAdvisorEvidencePacketForTrace,
  formatAdvisorEvidencePacketForPrompt,
  getCurrentQuestionEvidenceText,
} from "../src/lib/meeting/advisor-evidence-packet.js";
import { detectPersonalEvidenceRequirement } from "../src/lib/meeting/personal-evidence-guardrail.js";
import { buildActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import type {
  ActiveInterviewParent,
  InterviewSessionBrief,
} from "../src/lib/meeting/types.js";

test("ignores removed legacy Brief text fields", () => {
  const legacyBrief = {
    targetCompany: "Example",
    companyLocked: true,
    interviewTypes: ["coding"],
    focusAreas: "Coding and system design",
    notes: "I am available to start on September 1.",
  } as InterviewSessionBrief & { focusAreas: string; notes: string };
  const packet = buildAdvisorEvidencePacket({
    currentQuestion: {
      text: "Implement a stack using two queues.",
      source: "voice-lqu",
      sourceTurnIds: ["turn-question"],
      logicalQuestionUnitId: "lqu-question",
      revision: 2,
    },
    interviewSessionBrief: legacyBrief,
  });

  assert.equal(
    getCurrentQuestionEvidenceText(packet),
    "Implement a stack using two queues."
  );
  assert.equal(packet.preparation.guidanceHints.length, 0);
  assert.equal(packet.preparation.rawGuidanceRejectedAsFactCount, 0);
  const personalEvidence = detectPersonalEvidenceRequirement({
    questionText: getCurrentQuestionEvidenceText(packet),
    questionType: "coding",
    mode: "enforcement",
  });
  assert.equal(personalEvidence.requirement, "not-required");
});

test("excludes generated guidance from the retrieval query", () => {
  const packet = buildAdvisorEvidencePacket({
    currentQuestion: {
      text: "How would you design the cache?",
      source: "voice-lqu",
      sourceTurnIds: ["turn-question"],
    },
    generatedGuidance: {
      text: "Invented Microsoft MCP story with unsupported facts.",
      sourceTraceId: "trace-old",
    },
  });

  const query = buildAdvisorEvidenceRetrievalQuery(packet, "live");

  assert.match(query, /How would you design the cache/);
  assert.doesNotMatch(query, /Invented Microsoft MCP/);
});

test("adds source-owned setup to the prompt without widening KMB retrieval", () => {
  const setup = "The reliability tradeoff is consistency versus availability.";
  const packet = buildAdvisorEvidencePacket({
    currentQuestion: {
      text: "How would you reason about it?",
      source: "voice-lqu",
      sourceTurnIds: ["turn-ask"],
    },
    sourceOwnedSemanticContext: {
      text: setup,
      sourceTurnIds: ["turn-setup"],
      parentId: "parent-oasis",
      parentRevision: 4,
      retentionReason: "same-parent-adjacent-setup",
    },
  });

  const prompt = formatAdvisorEvidencePacketForPrompt(packet);
  const query = buildAdvisorEvidenceRetrievalQuery(packet, "live");
  const trace = formatAdvisorEvidencePacketForTrace(packet, query);
  assert.match(prompt, /source_owned_semantic_context/);
  assert.match(prompt, /consistency versus availability/);
  assert.match(prompt, /cannot create another ask/i);
  assert.doesNotMatch(query, /consistency versus availability/);
  assert.equal(trace.sourceOwnedSemanticContextPresent, true);
  assert.deepEqual(trace.sourceOwnedSemanticContextTurnIds, ["turn-setup"]);
});

test("keeps bounded generated continuity out of retrieval and marks it as non-authoritative", () => {
  const generatedText =
    "The prior option trades write latency for stronger consistency.";
  const packet = buildAdvisorEvidencePacket({
    currentQuestion: {
      text: "Can you explain that trade-off?",
      source: "voice-lqu",
      sourceTurnIds: ["turn-question"],
    },
    generatedContinuity: {
      contextReadScope: "bounded-recent-history",
      decisionReason: "authorized-deictic-followup",
      parentTaskId: "parent-a",
      deicticEvidence: ["named-deictic-reference"],
      capsules: [
        {
          id: "capsule-a",
          parentTaskId: "parent-a",
          parentRevision: 2,
          answerRevision: 3,
          sourceSuggestionId: "suggestion-a",
          sourceTraceId: "trace-a",
          text: generatedText,
          source: "generated-continuity",
          createdAt: 100,
        },
      ],
    },
  });

  const query = buildAdvisorEvidenceRetrievalQuery(packet, "live");
  const prompt = formatAdvisorEvidencePacketForPrompt(packet);
  const trace = formatAdvisorEvidencePacketForTrace(packet, query);

  assert.equal(packet.version, "advisor-evidence-v2");
  assert.doesNotMatch(query, /prior option trades/);
  assert.match(prompt, /generated[_ -]continuity/i);
  assert.match(prompt, /cannot establish facts/i);
  assert.match(prompt, /prior option trades/);
  assert.equal(trace.generatedContinuityExcludedFromRetrieval, true);
  assert.equal(trace.generatedContinuityCapsuleCount, 1);
});

test("builds a bounded continuity capsule without prior generated answers", () => {
  const parent: ActiveInterviewParent = {
    id: "parent-a",
    source: "voice",
    stableKind: "general-system-design",
    topic: "Design a ride sharing service",
    playbookPhase: "design_framing",
    phaseProgress: { requirement_clarification: true },
    supportedFactAnchors: [],
    canonicalQuestionSourceTurnIds: ["turn-parent"],
    createdAt: 1,
    updatedAt: 1,
    revisions: 1,
  };
  const task = buildActiveMeetingTask({
    parent: parent,
    runtimeRevision: 1,
  });
  assert.ok(task);
  task.parent.latestUsefulAnswer = "A generated answer that must not enter retrieval.";
  assert.equal("latestUsefulAnswer" in parent, false);
  const packet = buildAdvisorEvidencePacket({
    currentQuestion: {
      text: "How should location updates be stored?",
      source: "voice-lqu",
      sourceTurnIds: ["turn-followup"],
    },
    activeMeetingTask: task,
  });

  assert.equal(packet.continuity?.parentTaskId, "parent-a");
  assert.match(packet.continuity?.capsule ?? "", /ride sharing/);
  assert.doesNotMatch(
    packet.continuity?.capsule ?? "",
    /generated answer/
  );
  assert.doesNotMatch(buildAdvisorEvidenceRetrievalQuery(packet, "live"), /generated answer/);
});

test("records evidence roles without copying private Brief text", () => {
  const privateNote = "Private availability is September 1.";
  const legacyBrief = {
    targetCompany: "Example",
    companyLocked: true,
    interviewTypes: ["mixed"],
    notes: privateNote,
  } as InterviewSessionBrief & { notes: string };
  const packet = buildAdvisorEvidencePacket({
    currentQuestion: {
      text: "What is consistent hashing?",
      source: "screen-preflight",
      sourceTurnIds: [],
      sourceHash: "screen-source-a",
      screenObservationId: "screen-a",
    },
    interviewSessionBrief: legacyBrief,
  });
  const query = buildAdvisorEvidenceRetrievalQuery(packet, "screen-task");
  const trace = formatAdvisorEvidencePacketForTrace(packet, query);

  assert.equal(trace.currentQuestionEvidenceSource, "screen-preflight");
  assert.equal(trace.promptCurrentQuestionSourceHash, "screen-source-a");
  assert.equal(trace.currentQuestionScreenObservationId, "screen-a");
  assert.match(
    formatAdvisorEvidencePacketForPrompt(packet),
    /source_hash: screen-source-a/
  );
  assert.equal(trace.rejectedRawBriefFactAnchorCount, 0);
  assert.equal(JSON.stringify(trace).includes(privateNote), false);
});

test("formats personalized preparation authority and bounded trace counts", () => {
  const packet = buildAdvisorEvidencePacket({
    currentQuestion: {
      text: "Tell me about the Agentic Memory architecture.",
      source: "voice-lqu",
      sourceTurnIds: ["turn-project"],
    },
    personalizedGuidance: {
      strategy: {
        priorities: ["Explain the user problem before implementation."],
        risks: ["Avoid unsupported ownership claims."],
      },
      factEvidence: [
        {
          statementId: "fact-agentic-memory",
          content: "I designed a two-phase extraction and mutation pipeline.",
          ownership: "candidate-owned",
          allowedWording: "I designed the pipeline boundary.",
          prohibitedWording: ["I built the whole platform alone."],
          sourceIds: ["statement-1"],
        },
      ],
      openingItems: [],
      narratives: [
        {
          graphId: "agentic-memory",
          subjectKind: "project",
          subjectId: "agentic-memory",
          nodes: [
            {
              nodeId: "architecture",
              kind: "architecture",
              title: "Architecture",
              content: "Separate extraction from mutation decisions.",
              statementIds: ["fact-agentic-memory"],
            },
          ],
        },
      ],
      playbookOverlay: {
        canonicalPlaybookId: "project_deep_dive",
        expectedInterviewType: "project-deep-dive",
        evidenceStatementIds: ["fact-agentic-memory"],
        companyCriteria: ["Explain individual contribution."],
        prohibitedOverclaims: ["Do not claim sole ownership."],
      },
    },
    additionalRetrievalHints: [
      {
        role: "preparation-kmb-hint",
        text: "Agentic Memory implementation evidence",
      },
    ],
  });
  const prompt = formatAdvisorEvidencePacketForPrompt(packet);
  const trace = formatAdvisorEvidencePacketForTrace(packet);

  assert.match(prompt, /cannot create facts/i);
  assert.match(prompt, /fact id=fact-agentic-memory/);
  assert.match(prompt, /playbook overlay id=project_deep_dive/);
  assert.deepEqual(trace.preparationStrategyCategories, [
    "priorities",
    "risks",
  ]);
  assert.equal(trace.preparationFactEvidenceCount, 1);
  assert.equal(trace.preparationNarrativeNodeCount, 1);
  assert.equal(trace.preparationPlaybookOverlayId, "project_deep_dive");
  assert.deepEqual(trace.retrievalHintRoleCounts, {
    "preparation-kmb-hint": 1,
  });
});
