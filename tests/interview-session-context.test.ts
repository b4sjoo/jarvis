import assert from "node:assert/strict";
import test from "node:test";
import {
  createInterviewSessionContextFromBrief,
  detectInterviewCompanyDecision,
  updateInterviewSessionContextFromScreenText,
  updateInterviewSessionContextFromTurn,
} from "../src/lib/meeting/interview-session-context.js";
import type {
  InterviewSessionContext,
  TranscriptSpeaker,
  TranscriptTurn,
} from "../src/lib/meeting/types.js";

function transcriptTurn(
  text: string,
  speaker: TranscriptSpeaker = "them"
): TranscriptTurn {
  return {
    id: `turn-${speaker}`,
    speaker,
    text,
    startedAt: 1_000,
    endedAt: 2_000,
    isFinal: true,
    source: speaker === "me" ? "microphone" : "system-audio",
  };
}

test("selects an explicit Reddit target before rejecting AWS candidate history", () => {
  const update = updateInterviewSessionContextFromTurn(
    undefined,
    transcriptTurn(
      "I think you are a strong fit for Reddit's ML role. At AWS OpenSearch, I built several search systems."
    ),
    10_000
  );

  assert.equal(update.changed, true);
  assert.equal(update.targetCompany?.value, "Reddit");
  assert.equal(update.targetCompany?.normalized, "reddit");
  assert.equal(
    update.companyDecision?.mentionRole,
    "interview-target"
  );
  assert.equal(
    update.companyDecision?.disposition,
    "candidate-committed"
  );
});

test("rejects a microphone-side company claim as target authority", () => {
  const update = updateInterviewSessionContextFromTurn(
    undefined,
    transcriptTurn("I am from Amazon.", "me"),
    10_000
  );

  assert.equal(update.changed, false);
  assert.equal(update.context.targetCompany, undefined);
  assert.equal(
    update.companyDecision?.disposition,
    "candidate-rejected-speaker"
  );
  assert.equal(
    update.context.companyHistory?.at(-1)?.disposition,
    "candidate-rejected-speaker"
  );
});

test("normalizes interviewer AWS affiliation to Amazon", () => {
  const update = updateInterviewSessionContextFromTurn(
    undefined,
    transcriptTurn(
      "Hi, I am the hiring manager from AWS and will run today's interview."
    ),
    10_000
  );

  assert.equal(update.changed, true);
  assert.equal(update.targetCompany?.value, "Amazon");
  assert.equal(update.targetCompany?.normalized, "amazon");
  assert.equal(
    update.companyDecision?.mentionRole,
    "interviewer-employer"
  );
});

test("does not treat a candidate-history question as interview company evidence", () => {
  const update = updateInterviewSessionContextFromTurn(
    undefined,
    transcriptTurn("What kind of work have you done at AWS?"),
    10_000
  );

  assert.equal(update.changed, false);
  assert.equal(update.context.targetCompany, undefined);
  assert.equal(
    update.companyDecision?.mentionRole,
    "candidate-history"
  );
  assert.equal(
    update.companyDecision?.disposition,
    "candidate-rejected-role"
  );
});

test("does not infer a target from company comparisons", () => {
  const decision = detectInterviewCompanyDecision({
    text: "How do you compare Google with Microsoft and Amazon?",
    source: "transcript",
    speaker: "them",
    now: 10_000,
  });

  assert.equal(decision.candidate, undefined);
  assert.equal(decision.mentionRole, "comparison-only");
  assert.equal(decision.disposition, "candidate-rejected-role");
  assert.deepEqual(
    new Set(decision.mentionedCompanies),
    new Set(["Amazon", "Microsoft", "Google"])
  );
});

test("does not let same-company transcript evidence downgrade a brief lock", () => {
  const locked = createInterviewSessionContextFromBrief(
    {
      targetCompany: "Amazon",
      companyLocked: true,
      interviewTypes: ["mixed"],
      focusAreas: "",
      notes: "",
      updatedAt: 5_000,
    },
    5_000
  );
  const update = updateInterviewSessionContextFromTurn(
    locked,
    transcriptTurn("This is your Amazon interview."),
    10_000
  );

  assert.equal(update.changed, false);
  assert.equal(update.context.targetCompany?.source, "brief");
  assert.equal(update.context.targetCompany?.confidence, 1);
  assert.equal(
    update.companyDecision?.disposition,
    "candidate-rejected-lock"
  );
  assert.equal(
    update.companyDecision?.reason,
    "same-company-lower-authority-cannot-downgrade-lock"
  );
});

test("does not let screen evidence replace a different locked company", () => {
  const locked = createInterviewSessionContextFromBrief(
    {
      targetCompany: "Microsoft",
      companyLocked: true,
      interviewTypes: ["mixed"],
      focusAreas: "",
      notes: "",
      updatedAt: 5_000,
    },
    5_000
  );
  const update = updateInterviewSessionContextFromScreenText(
    locked,
    "Amazon interview",
    "screen preflight",
    10_000
  );

  assert.equal(update.changed, false);
  assert.equal(update.context.targetCompany?.value, "Microsoft");
  assert.equal(
    update.companyDecision?.disposition,
    "candidate-rejected-lock"
  );
});

test("allows stronger explicit evidence to replace an unlocked weak brief", () => {
  const current: InterviewSessionContext = {
    targetCompany: {
      value: "Microsoft",
      normalized: "microsoft",
      confidence: 0.82,
      source: "transcript",
      evidence: "weak inference",
      updatedAt: 5_000,
    },
  };
  const update = updateInterviewSessionContextFromScreenText(
    current,
    "Amazon interview",
    "screen preflight",
    10_000
  );

  assert.equal(update.changed, true);
  assert.equal(update.targetCompany?.value, "Amazon");
  assert.equal(update.targetCompany?.source, "screen");
});

test("abstains when text names multiple explicit interview targets", () => {
  const decision = detectInterviewCompanyDecision({
    text: "We will cover both the Amazon interview and Google interview.",
    source: "transcript",
    speaker: "them",
    now: 10_000,
  });

  assert.equal(decision.candidate, undefined);
  assert.equal(decision.disposition, "candidate-conflict");
  assert.deepEqual(
    new Set(decision.mentionedCompanies),
    new Set(["Amazon", "Google"])
  );
});

test("accepts an unregistered company from explicit screen evidence", () => {
  const update = updateInterviewSessionContextFromScreenText(
    undefined,
    "Reddit interview",
    "screen preflight",
    10_000
  );

  assert.equal(update.changed, true);
  assert.equal(update.targetCompany?.value, "Reddit");
  assert.equal(update.targetCompany?.normalized, "reddit");
});

test("preserves canonical mappings for established company aliases", () => {
  const cases = [
    ["AWS", "Amazon"],
    ["Facebook", "Meta"],
    ["TikTok", "ByteDance"],
    ["Open AI", "OpenAI"],
    ["X AI", "xAI"],
  ] as const;

  for (const [alias, expectedCompany] of cases) {
    const decision = detectInterviewCompanyDecision({
      text: `This is your ${alias} interview.`,
      source: "transcript",
      speaker: "them",
      now: 10_000,
    });

    assert.equal(
      decision.candidate?.value,
      expectedCompany,
      alias
    );
    assert.equal(decision.disposition, "candidate-proposed", alias);
  }
});
