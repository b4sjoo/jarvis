import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { formatAdvisorEvidencePacketForPrompt } from "../src/lib/meeting/advisor-evidence-packet.js";
import { formatInterviewSessionBriefForPrompt, formatInterviewSessionContextForPrompt } from "../src/lib/meeting/interview-session-context.js";
import { formatInterviewPlaybookForPrompt, selectInterviewPlaybook, withInterviewPlaybookPhase } from "../src/lib/meeting/interview-playbook.js";
import { formatFactAnchorDecisionForPrompt } from "../src/lib/meeting/fact-anchor-guardrail.js";
import { formatProjectBindingDecisionForPrompt } from "../src/lib/meeting/project-binding.js";
import { formatPlaybookPhaseDecisionForPrompt } from "../src/lib/meeting/playbook-phase.js";
import { formatBoundedParentReadContextForPrompt } from "../src/lib/meeting/response-only-task-scope.js";
import { formatCapacityEstimationGuardrailForPrompt, resolveCapacityEstimationGuardrail } from "../src/lib/meeting/capacity-estimation-guardrail.js";
import { formatCodingSolutionManifestForPrompt } from "../src/lib/meeting/coding-solution-manifest.js";
import { SCREEN_FOCUSED_CODE_EXPLANATION_INSTRUCTION, SCREEN_TASK_SYSTEM_PROMPT } from "../src/lib/meeting/screen-task-system-prompt.js";

// Execute the production prompt composition and its real pure dependencies,
// without loading capture, native I/O, or a model provider.
const service = ts.createSourceFile("screen-observation.service.ts",
  readFileSync("src/lib/meeting/screen-observation.service.ts", "utf8"), ts.ScriptTarget.Latest, true);
const declarations = [
  "buildScreenTaskUserMessage", "formatScreenPreflightForPrompt",
  "formatScreenTaskResponsePreferences", "formatCaptureTargetForPrompt",
  "formatCursorFocusForPrompt", "formatImageOrderForPrompt",
].map(name => {
  const declaration = service.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `production function ${name}`);
  return declaration.getText(service);
});
const buildMessage = vm.runInNewContext(ts.transpileModule([
  ...declarations, "buildScreenTaskUserMessage",
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, {
  formatAdvisorEvidencePacketForPrompt, formatInterviewSessionBriefForPrompt,
  formatInterviewSessionContextForPrompt, formatInterviewPlaybookForPrompt,
  withInterviewPlaybookPhase, formatFactAnchorDecisionForPrompt,
  formatProjectBindingDecisionForPrompt, formatPlaybookPhaseDecisionForPrompt,
  formatBoundedParentReadContextForPrompt, formatCapacityEstimationGuardrailForPrompt,
  resolveCapacityEstimationGuardrail, SCREEN_FOCUSED_CODE_EXPLANATION_INSTRUCTION,
}) as (input: Record<string, unknown>) => string;

const cachedManifest = formatCodingSolutionManifestForPrompt({
  version: 1,
  baseline: { approach: "Earlier DP answer", dataStructures: ["memo table"], time: "O(n)", space: "O(n)" },
  optimized: { approach: "Earlier DP answer", dataStructures: ["memo table"], time: "O(n)", space: "O(n)" },
  sameSolution: true, reason: "Earlier generated candidate", visibleCandidate: "optimized",
});

function compose(question: string, phase = "implementation_validation", focusBand = true) {
  return buildMessage({
    observation: {
      focusImageBase64: focusBand ? "focus-image-fixture" : undefined,
      captureTarget: {
        targetType: "active-window", title: "Editor", width: 1200, height: 900, x: 0, y: 0,
        cursor: { globalX: 500, globalY: 400, targetX: 500, targetY: 400, insideTarget: true },
        focusRegion: focusBand ? { imageWidth: 1200, imageHeight: 160, width: 1200, height: 160, x: 0, y: 320, cursorX: 500, cursorY: 80 } : undefined,
      },
    },
    screenPreflight: { questionType: "coding", question, programmingLanguage: "Python" },
    interviewPlaybook: selectInterviewPlaybook({ questionType: "coding" }),
    playbookPhaseDecision: {
      phase, action: "stay", flags: [], reason: "Committed fixture phase",
      requiredArtifacts: phase === "implementation_validation" ? ["answer", "code", "complexity"] : ["answer"],
    },
    codingSolutionManifestContext: cachedManifest,
  });
}

test("SC-M1 prompt contract gives the current explicit method priority within unchanged phase/manifest composition", () => {
  const user = compose("Implement this using brute force / exhaustive enumeration.");
  assert.match(user, /Recommended phase: implementation_validation/);
  assert.match(user, /visibleCandidate='optimized'/);
  assert.ok(user.includes(cachedManifest));
  assert.match(user, /Required artifacts this phase: answer, code, complexity/);
  assert.match(SCREEN_TASK_SYSTEM_PROMPT, /explicit method requirement in the current authorized active question or code region/);
  assert.match(SCREEN_TASK_SYSTEM_PROMPT, /including a request for brute force or exhaustive enumeration/);
  assert.match(SCREEN_TASK_SYSTEM_PROMPT, /takes priority over generic optimized-candidate wording in the playbook\/phase template and over a cached solution manifest/);
  assert.match(SCREEN_TASK_SYSTEM_PROMPT, /Keep Answer, Approach, any authorized Code, and Complexity consistent with the requested method/);
});

test("SC-M2 prompt contract preserves try/debug/finish approach and focus/full target selection", () => {
  assert.match(SCREEN_TASK_SYSTEM_PROMPT, /try, debug, or finish the shown implementation, work within and repair that approach first/);
  assert.match(SCREEN_TASK_SYSTEM_PROMPT, /do not silently replace it with a different algorithm, dynamic programming, or memoization merely because it is faster/);
  const focused = compose("Debug and finish the shown brute-force implementation.");
  assert.match(focused, /Image 1: cursor-centered horizontal focus band/);
  assert.match(focused, /Image 2: full active-window screenshot/);
  assert.match(focused, /Use Image 2 only to recover surrounding context for that selected target/);
  const fullOnly = compose("Try this implementation.", "implementation_validation", false);
  assert.match(fullOnly, /Image 1: full active-window screenshot. No cursor-centered horizontal focus band was included/);
});

test("SC-M3 prompt contract retains defaults, later optimization, and historical-comment counterexamples", () => {
  for (const question of ["Solve the current problem.", "Now optimize the earlier brute-force solution.", "Old comment mentions brute force; solve the active problem."]) {
    const user = compose(question);
    assert.ok(user.includes(question));
    assert.match(user, /visibleCandidate='optimized'/);
    assert.ok(user.includes(cachedManifest));
  }
  assert.match(SCREEN_TASK_SYSTEM_PROMPT, /Without an explicit method requirement or a request to work on the shown implementation, retain the existing phase guidance and optimized default/);
  assert.match(SCREEN_TASK_SYSTEM_PROMPT, /A later explicit request to optimize can supersede the earlier method/);
  assert.match(SCREEN_TASK_SYSTEM_PROMPT, /historical comments or nearby mentions of other algorithms alone are not lasting method constraints/);
});

test("SC-M4 prompt contract keeps phase, source binding, and artifact eligibility across all Coding phases", () => {
  for (const phase of ["baseline_reasoning", "optimized_pseudocode", "implementation_validation"]) {
    const user = compose("Use exhaustive enumeration.", phase);
    assert.ok(user.includes(`Recommended phase: ${phase}`));
    assert.match(user, /If its source is voice-lqu, answer that exact bounded ask using the screenshot as visual evidence/);
    assert.match(user, /Only populate Code, Complexity, or Whiteboard when <playbook_phase_state> lists that artifact as required/);
    assert.match(user, /Output '-' for an artifact that is not required/);
    assert.ok(user.includes(cachedManifest));
    if (phase !== "implementation_validation") assert.match(user, /Required artifacts this phase: answer\n/);
  }
  assert.match(SCREEN_TASK_SYSTEM_PROMPT, /phase and required-artifact contract still govern reasoning, pseudocode, and Code\/Complexity eligibility/);
  assert.match(SCREEN_TASK_SYSTEM_PROMPT, /a method request grants no additional artifact authority/);
  assert.match(SCREEN_TASK_SYSTEM_PROMPT, /Do not promote a baseline question to implementation merely because it arrived through a screenshot/);
});
