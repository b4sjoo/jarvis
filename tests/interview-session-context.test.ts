import assert from "node:assert/strict";
import test from "node:test";
import {
  createInterviewSessionContextFromBrief,
  normalizeInterviewBriefCompany,
  normalizeInterviewBriefCompanyLock,
  updateInterviewSessionContextFromBrief,
} from "../src/lib/meeting/interview-session-context.js";

test("only enables a company lock when an authoritative company is present", () => {
  assert.equal(normalizeInterviewBriefCompanyLock("", true), false);
  assert.equal(normalizeInterviewBriefCompanyLock("   ", true), false);
  assert.equal(normalizeInterviewBriefCompanyLock("Amazon", false), false);
  assert.equal(normalizeInterviewBriefCompanyLock("Amazon", true), true);
});

test("canonicalizes aliases only after an authoritative value is supplied", () => {
  const cases = [
    ["AWS", "Amazon", "amazon"],
    ["Facebook", "Meta", "meta"],
    ["TikTok", "ByteDance", "bytedance"],
    ["Open AI", "OpenAI", "openai"],
    ["X AI", "xAI", "xai"],
  ] as const;

  for (const [input, expectedValue, expectedNormalized] of cases) {
    assert.deepEqual(normalizeInterviewBriefCompany(input), {
      value: expectedValue,
      normalized: expectedNormalized,
    });
  }
});

test("preserves an explicit custom company without scanning surrounding language", () => {
  assert.deepEqual(normalizeInterviewBriefCompany("Reddit"), {
    value: "Reddit",
    normalized: "reddit",
  });
  assert.deepEqual(normalizeInterviewBriefCompany("I am from Amazon"), {
    value: "I am from Amazon",
    normalized: "i-am-from-amazon",
  });
});

test("creates company context only from the authoritative interview brief", () => {
  const context = createInterviewSessionContextFromBrief(
    {
      targetCompany: "AWS",
      companyLocked: true,
      interviewTypes: [],
      updatedAt: 5_000,
    },
    10_000
  );

  assert.deepEqual(context?.targetCompany, {
    value: "Amazon",
    normalized: "amazon",
    confidence: 1,
    source: "brief",
    evidence: "Interview Session Brief",
    updatedAt: 5_000,
  });
});

test("replaces and clears only brief-owned company context", () => {
  const initial = createInterviewSessionContextFromBrief({
    targetCompany: "Microsoft",
    companyLocked: false,
    interviewTypes: [],
    updatedAt: 5_000,
  });
  const replaced = updateInterviewSessionContextFromBrief(initial, {
    targetCompany: "Google",
    companyLocked: true,
    interviewTypes: [],
    updatedAt: 6_000,
  });

  assert.equal(replaced.changed, true);
  assert.equal(replaced.targetCompany?.value, "Google");
  assert.equal(replaced.targetCompany?.confidence, 1);

  const cleared = updateInterviewSessionContextFromBrief(
    replaced.context,
    {
      targetCompany: "",
      companyLocked: false,
      interviewTypes: [],
      updatedAt: 7_000,
    }
  );
  assert.equal(cleared.changed, true);
  assert.equal(cleared.context.targetCompany, undefined);
});

test("accepts an explicit human value even when it is not a known company", () => {
  const context = createInterviewSessionContextFromBrief({
    targetCompany: "Taiwan",
    companyLocked: true,
    interviewTypes: [],
    updatedAt: 5_000,
  });

  assert.equal(context?.targetCompany?.value, "Taiwan");
  assert.equal(context?.targetCompany?.normalized, "taiwan");
  assert.equal(context?.targetCompany?.source, "brief");
});
