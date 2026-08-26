import assert from "node:assert/strict";
import test from "node:test";
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
