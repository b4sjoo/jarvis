import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAdvisorEvidencePacket,
  buildAdvisorEvidenceRetrievalQuery,
  formatAdvisorEvidencePacketForTrace,
  getCurrentQuestionEvidenceText,
} from "../src/lib/meeting/advisor-evidence-packet.js";
import { detectPersonalEvidenceRequirement } from "../src/lib/meeting/personal-evidence-guardrail.js";
import { buildActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import type { ActiveInterviewParent } from "../src/lib/meeting/types.js";

test("keeps raw Brief text out of current-question evidence", () => {
  const packet = buildAdvisorEvidencePacket({
    currentQuestion: {
      text: "Implement a stack using two queues.",
      source: "voice-lqu",
      sourceTurnIds: ["turn-question"],
      logicalQuestionUnitId: "lqu-question",
      revision: 2,
    },
    interviewSessionBrief: {
      targetCompany: "Example",
      companyLocked: true,
      interviewTypes: ["coding"],
      focusAreas: "Coding and system design",
      notes: "I am available to start on September 1.",
    },
  });

  assert.equal(
    getCurrentQuestionEvidenceText(packet),
    "Implement a stack using two queues."
  );
  assert.equal(packet.preparation.guidanceHints.length, 2);
  assert.equal(packet.preparation.rawGuidanceRejectedAsFactCount, 2);
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

test("builds a bounded continuity capsule without prior generated answers", () => {
  const parent: ActiveInterviewParent = {
    id: "parent-a",
    source: "voice",
    stableKind: "general-system-design",
    topic: "Design a ride sharing service",
    playbookPhase: "design_framing",
    phaseProgress: { requirement_clarification: true },
    supportedFactAnchors: [],
    latestUsefulAnswer: "A generated answer that must not enter retrieval.",
    canonicalQuestionSourceTurnIds: ["turn-parent"],
    createdAt: 1,
    updatedAt: 1,
    revisions: 1,
  };
  const task = buildActiveMeetingTask({
    activeInterviewTask: parent,
  });
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
});

test("records evidence roles without copying private Brief text", () => {
  const privateNote = "Private availability is September 1.";
  const packet = buildAdvisorEvidencePacket({
    currentQuestion: {
      text: "What is consistent hashing?",
      source: "screen-preflight",
      sourceTurnIds: [],
      screenObservationId: "screen-a",
    },
    interviewSessionBrief: {
      targetCompany: "Example",
      companyLocked: true,
      interviewTypes: ["mixed"],
      focusAreas: "",
      notes: privateNote,
    },
  });
  const query = buildAdvisorEvidenceRetrievalQuery(packet, "screen-task");
  const trace = formatAdvisorEvidencePacketForTrace(packet, query);

  assert.equal(trace.currentQuestionEvidenceSource, "screen-preflight");
  assert.equal(trace.currentQuestionScreenObservationId, "screen-a");
  assert.equal(trace.rejectedRawBriefFactAnchorCount, 1);
  assert.equal(JSON.stringify(trace).includes(privateNote), false);
});
