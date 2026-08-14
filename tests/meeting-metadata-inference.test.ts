import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeMeetingMetadataInferenceLease,
  buildMeetingMetadataInferencePrompts,
  buildMeetingMetadataInferenceRequest,
  compareMeetingMetadataInference,
  createMeetingMetadataInferenceLease,
  decideMeetingMetadataInferenceEligibility,
  parseMeetingMetadataInferenceOutput,
  projectMeetingMetadataOpeningEvidence,
} from "../src/lib/meeting/meeting-metadata-inference.js";
import type {
  InterviewTargetCompany,
  TranscriptTurn,
} from "../src/lib/meeting/types.js";

function turn(
  id: string,
  text: string,
  speaker: "me" | "them" = "them",
  startedAt = 1_000
): TranscriptTurn {
  return {
    id,
    text,
    speaker,
    startedAt,
    endedAt: startedAt + 500,
    isFinal: true,
    source: speaker === "them" ? "system-audio" : "microphone",
  };
}

function requestFrom(turns: TranscriptTurn[], company?: InterviewTargetCompany) {
  const evidence = projectMeetingMetadataOpeningEvidence({
    transcriptTurns: turns,
    sessionStartedAt: 500,
  });
  return buildMeetingMetadataInferenceRequest({
    sessionId: "session-a",
    evidence,
    authoritativeCompany: company,
  });
}

test("projects only bounded interviewer opening evidence", () => {
  const turns = [
    turn("me-1", "I am the candidate.", "me"),
    ...Array.from({ length: 8 }, (_, index) =>
      turn(
        `them-${index + 1}`,
        `${index + 1}: ${"x".repeat(700)}`,
        "them",
        1_000 + index * 1_000
      )
    ),
    turn("late", "I am from Late Company.", "them", 700_000),
  ];
  const evidence = projectMeetingMetadataOpeningEvidence({
    transcriptTurns: turns,
    sessionStartedAt: 500,
  });

  assert.equal(evidence.turns.length, 3);
  assert.equal(evidence.turns.every((item) => item.text.length <= 600), true);
  assert.equal(evidence.totalChars, 1_800);
  assert.equal(evidence.omittedTurnCount, 5);
  assert.equal(
    decideMeetingMetadataInferenceEligibility({
      currentTurnId: "them-1",
      evidence,
    }).eligible,
    true
  );
  assert.equal(
    decideMeetingMetadataInferenceEligibility({
      currentTurnId: "them-4",
      evidence,
    }).reason,
    "outside-bounded-opening-window"
  );
});

test("builds an atomic company-only prompt", () => {
  const request = requestFrom([
    turn(
      "them-1",
      "I am the recruiter from Oracle. Your AWS work is relevant to this role."
    ),
  ]);
  const prompts = buildMeetingMetadataInferencePrompts(request);

  assert.match(prompts.systemPrompt, /which organization/i);
  assert.match(prompts.systemPrompt, /candidate's former employer/i);
  assert.doesNotMatch(prompts.systemPrompt, /questionType/);
  assert.match(prompts.userMessage, /Oracle/);
  assert.match(prompts.userMessage, /AWS/);
});

test("strictly parses grounded company and abstention proposals", () => {
  const request = requestFrom([
    turn(
      "them-1",
      "I am the recruiter from Oracle, based in Taiwan."
    ),
  ]);
  const parsed = parseMeetingMetadataInferenceOutput(
    JSON.stringify({
      schemaVersion: 1,
      company: "Oracle",
      confidence: 0.98,
      evidenceSpans: ["the recruiter from Oracle"],
      abstainReason: null,
    }),
    request
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.company, "Oracle");

  const abstained = parseMeetingMetadataInferenceOutput(
    JSON.stringify({
      schemaVersion: 1,
      company: null,
      confidence: 0.2,
      evidenceSpans: [],
      abstainReason: "Only a vendor location is named.",
    }),
    request
  );
  assert.equal(abstained.ok, true);
  if (abstained.ok) assert.equal(abstained.value.company, null);
});

test("rejects invented evidence and cross-operation fields", () => {
  const request = requestFrom([
    turn("them-1", "I am the recruiter from Oracle."),
  ]);
  const invented = parseMeetingMetadataInferenceOutput(
    JSON.stringify({
      schemaVersion: 1,
      company: "Oracle",
      confidence: 0.99,
      evidenceSpans: ["Oracle is conducting the interview"],
      abstainReason: null,
    }),
    request
  );
  assert.equal(invented.ok, false);
  if (!invented.ok) assert.equal(invented.reason, "invalid-evidence-span");

  const broad = parseMeetingMetadataInferenceOutput(
    JSON.stringify({
      schemaVersion: 1,
      company: "Oracle",
      confidence: 0.99,
      evidenceSpans: ["recruiter from Oracle"],
      abstainReason: null,
      questionType: "project-deep-dive",
    }),
    request
  );
  assert.equal(broad.ok, false);
  if (!broad.ok) assert.equal(broad.reason, "non-metadata-field-present");
});

test("lease rejects newer evidence, epochs, and authoritative company changes", () => {
  const authoritative: InterviewTargetCompany = {
    value: "Oracle",
    normalized: "oracle",
    confidence: 1,
    source: "brief",
    evidence: "Preparation Snapshot",
    updatedAt: 1_000,
  };
  const request = requestFrom(
    [turn("them-1", "I am the recruiter from Oracle.")],
    authoritative
  );
  const lease = createMeetingMetadataInferenceLease({
    sessionId: "session-a",
    runtimeEpoch: 3,
    request,
    createdAt: 2_000,
  });
  const current = {
    currentOperationId: lease.operationId,
    sessionId: "session-a",
    runtimeEpoch: 3,
    evidence: request.openingEvidence,
    authoritativeCompany: authoritative,
  };
  assert.deepEqual(authorizeMeetingMetadataInferenceLease(lease, current), {
    authorized: true,
  });
  assert.equal(
    authorizeMeetingMetadataInferenceLease(lease, {
      ...current,
      runtimeEpoch: 4,
    }).authorized,
    false
  );
  assert.equal(
    authorizeMeetingMetadataInferenceLease(lease, {
      ...current,
      authoritativeCompany: { ...authoritative, value: "Google" },
    }).authorized,
    false
  );
});

test("compares proposals without granting mutation authority", () => {
  const authoritative: InterviewTargetCompany = {
    value: "Oracle",
    normalized: "oracle",
    confidence: 1,
    source: "brief",
    evidence: "Preparation Snapshot",
    updatedAt: 1_000,
  };
  const proposal = {
    schemaVersion: 1 as const,
    company: "Oracle",
    confidence: 0.98,
    evidenceSpans: ["from Oracle"],
  };
  assert.equal(
    compareMeetingMetadataInference({
      authoritativeCompany: authoritative,
      proposal,
    }).disposition,
    "agreement"
  );
  assert.equal(
    compareMeetingMetadataInference({ proposal }).disposition,
    "unresolved-proposal"
  );
  assert.equal(
    compareMeetingMetadataInference({
      authoritativeCompany: authoritative,
      proposal: { ...proposal, company: "Taiwan" },
    }).disposition,
    "conflict"
  );
});

test("canonicalizes aliases only after a model proposal exists", () => {
  const authoritative: InterviewTargetCompany = {
    value: "Amazon",
    normalized: "amazon",
    confidence: 1,
    source: "brief",
    evidence: "Preparation Snapshot",
    updatedAt: 1_000,
  };
  assert.equal(
    compareMeetingMetadataInference({
      authoritativeCompany: authoritative,
      proposal: {
        schemaVersion: 1,
        company: "AWS",
        confidence: 0.97,
        evidenceSpans: ["from AWS"],
      },
    }).disposition,
    "agreement"
  );
});
