import assert from "node:assert/strict";
import test from "node:test";
import { resolveScreenPreflightQuestionTypeAuthority } from "../src/lib/meeting/task-taxonomy.js";
import { SCREEN_TASK_SYSTEM_PROMPT } from "../src/lib/meeting/screen-task-system-prompt.js";

test("keeps Screen Coding output subordinate to the committed phase", () => {
  assert.match(
    SCREEN_TASK_SYSTEM_PROMPT,
    /Follow the committed Coding playbook phase/
  );
  assert.match(
    SCREEN_TASK_SYSTEM_PROMPT,
    /emit Code and Complexity only when the playbook phase state requires them/
  );
  assert.doesNotMatch(
    SCREEN_TASK_SYSTEM_PROMPT,
    /prioritize a complete runnable implementation/
  );
});

test("limits Screen visual claims to evidence supplied in the request", () => {
  assert.match(SCREEN_TASK_SYSTEM_PROMPT, /Authorized Evidence/);
  assert.match(
    SCREEN_TASK_SYSTEM_PROMPT,
    /never claim to see specific visual content/
  );
  assert.match(SCREEN_TASK_SYSTEM_PROMPT, /answer any supported non-visual part/);
});

test("grants Screen Type authority only to a raw model type", () => {
  const parsed = resolveScreenPreflightQuestionTypeAuthority({
    rawQuestionType: "general-system-design",
    fallbackQuestionType: "field-knowledge",
  });

  assert.equal(parsed.questionType, "general-system-design");
  assert.equal(parsed.fallbackQuestionType, undefined);
  assert.equal(parsed.authorityAuthorized, true);
});

test("keeps local Screen Type inference trace-only after an invalid model type", () => {
  const parsed = resolveScreenPreflightQuestionTypeAuthority({
    rawQuestionType: "architecture",
    fallbackQuestionType: "general-system-design",
  });

  assert.equal(parsed.questionType, "unknown");
  assert.equal(parsed.fallbackQuestionType, "general-system-design");
  assert.equal(parsed.authorityAuthorized, false);
});

test("keeps regex recovery trace-only after Screen preflight JSON failure", () => {
  const parsed = resolveScreenPreflightQuestionTypeAuthority({
    fallbackQuestionType: "coding",
  });

  assert.equal(parsed.questionType, "unknown");
  assert.equal(parsed.fallbackQuestionType, "coding");
  assert.equal(parsed.authorityAuthorized, false);
});
