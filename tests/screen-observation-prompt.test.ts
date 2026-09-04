import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveScreenPreflightQuestionTypeAuthority } from "../src/lib/meeting/task-taxonomy.js";
import {
  SCREEN_FOCUSED_CODE_EXPLANATION_INSTRUCTION,
  SCREEN_TASK_SYSTEM_PROMPT,
} from "../src/lib/meeting/screen-task-system-prompt.js";

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
  assert.match(SCREEN_TASK_SYSTEM_PROMPT, /pseudocode in Approach/);
  assert.match(SCREEN_TASK_SYSTEM_PROMPT, /pseudocode is not a runnable implementation/);
});

test("limits Screen visual claims to evidence supplied in the request", () => {
  assert.match(SCREEN_TASK_SYSTEM_PROMPT, /Authorized Evidence/);
  assert.match(
    SCREEN_TASK_SYSTEM_PROMPT,
    /never claim to see specific visual content/
  );
  assert.match(SCREEN_TASK_SYSTEM_PROMPT, /answer any supported non-visual part/);
});

test("uses one focused-code explanation contract in both Screen prompts", () => {
  const source = readFileSync(
    "src/lib/meeting/screen-observation.service.ts",
    "utf8"
  );

  assert.match(
    SCREEN_FOCUSED_CODE_EXPLANATION_INSTRUCTION,
    /how it contributes to the surrounding function, algorithm, state transition, or data flow/
  );
  assert.match(
    SCREEN_TASK_SYSTEM_PROMPT,
    /do not merely translate each line/
  );
  assert.equal(
    source.match(/SCREEN_FOCUSED_CODE_EXPLANATION_INSTRUCTION/g)?.length,
    2
  );
  assert.match(source, /visibly highlighted or selected/);
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
