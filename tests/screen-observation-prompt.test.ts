import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { resolveScreenPreflightQuestionTypeAuthority } from "../src/lib/meeting/task-taxonomy.js";
import {
  SCREEN_FOCUSED_CODE_EXPLANATION_INSTRUCTION,
  SCREEN_TASK_SYSTEM_PROMPT,
} from "../src/lib/meeting/screen-task-system-prompt.js";

function preflightPromptBuilders() {
  const source = ts.createSourceFile(
    "screen-observation.service.ts",
    readFileSync("src/lib/meeting/screen-observation.service.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const names = [
    "buildScreenPreflightUserMessage",
    "buildScreenPreflightImageInputs",
    "formatCaptureTargetForPrompt",
    "formatCursorFocusForPrompt",
    "formatImageOrderForPrompt",
  ];
  const declarations = names.map((name) => {
    const declaration = source.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === name
    );
    assert.ok(declaration, `production function ${name}`);
    return declaration.getText(source);
  });
  // Evaluate only the pure production builders; no capture or provider functions.
  return vm.runInNewContext(ts.transpileModule([
    ...declarations,
    "({ buildScreenPreflightUserMessage, buildScreenPreflightImageInputs })",
  ].join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText) as {
    buildScreenPreflightUserMessage: (input: {
      observation: unknown;
      recentTranscript?: string;
    }) => string;
    buildScreenPreflightImageInputs: (observation: unknown) => unknown[];
  };
}

test("SL-E1/E6 preflight prompt requests actual focus location and bounded literal evidence, not full-code coverage", () => {
  const { buildScreenPreflightUserMessage } = preflightPromptBuilders();
  const prompt = buildScreenPreflightUserMessage({ observation: {} });
  const instruction = prompt.split("\n").find((line) => line.startsWith("focusedEvidenceSummary:"));
  assert.ok(instruction);
  assert.match(instruction, /at most 800 characters/);
  assert.match(instruction, /actual cursor\/current-line location/);
  assert.match(instruction, /visibly highlighted or selected range and the object it points to/);
  assert.match(instruction, /distinguish a current-line highlight from a multi-line selection/);
  assert.match(instruction, /visible identifiers, line numbers\/ranges/);
  assert.match(instruction, /error\/diagram\/UI labels/);
  assert.match(instruction, /focus band for location and the supplied full screenshot for visible nearby context/);
  assert.match(instruction, /cropped or unreadable portions as unknown; do not infer unseen content/);
  assert.match(instruction, /single localized signature or partial block is useful/);
  assert.match(instruction, /do not require full-code coverage/);
  assert.match(instruction, /Return null when no such focused evidence is visible/);
  assert.match(prompt, /question: the active visible interview\/software-engineering question near the cursor, or null\./);
  assert.match(prompt, /questionType: classify the question\./);
  assert.match(prompt, /Return JSON only, with no Markdown fences\./);
});

test("SL-E6 preflight builders keep focus/full image order and omit Voice history", () => {
  const { buildScreenPreflightUserMessage, buildScreenPreflightImageInputs } = preflightPromptBuilders();
  const observation = {
    imageBase64: "full-image-fixture",
    imageMediaType: "image/png",
    focusImageBase64: "focus-image-fixture",
    focusImageMediaType: "image/jpeg",
    captureTarget: {
      targetType: "active-window", title: "Editor", width: 1200, height: 900, x: 0, y: 0,
      cursor: { globalX: 500, globalY: 400, targetX: 500, targetY: 400, insideTarget: true },
      focusRegion: { imageWidth: 1200, imageHeight: 160, width: 1200, height: 160, x: 0, y: 320, cursorX: 500, cursorY: 80 },
    },
  };
  const prompt = buildScreenPreflightUserMessage({
    observation,
    recentTranscript: "PRIVATE VOICE HISTORY: Explain lines 31-37",
  });
  assert.match(prompt, /Image 1: cursor-centered horizontal focus band/);
  assert.match(prompt, /Image 2: full active-window screenshot/);
  assert.match(prompt, /Transcript content is intentionally omitted/);
  assert.doesNotMatch(prompt, /PRIVATE VOICE HISTORY|Explain lines 31-37/);
  assert.deepEqual(JSON.parse(JSON.stringify(buildScreenPreflightImageInputs(observation))), [
    { base64: "focus-image-fixture", mediaType: "image/jpeg" },
    { base64: "full-image-fixture", mediaType: "image/png" },
  ]);
  const fullOnly = { imageBase64: observation.imageBase64, imageMediaType: observation.imageMediaType };
  assert.match(buildScreenPreflightUserMessage({ observation: fullOnly }), /No cursor-centered horizontal focus band was included/);
  assert.deepEqual(JSON.parse(JSON.stringify(buildScreenPreflightImageInputs(fullOnly))), [
    { base64: "full-image-fixture", mediaType: "image/png" },
  ]);
});

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

test("does not force a first-person Behavioral story without supporting evidence", () => {
  assert.match(
    SCREEN_TASK_SYSTEM_PROMPT,
    /eligible fact evidence supports a relevant story/i
  );
  assert.match(
    SCREEN_TASK_SYSTEM_PROMPT,
    /bounded framework or explicit hypothetical example/i
  );
});

test("keeps Screen project deep dives available for bounded product judgment", () => {
  const source = readFileSync(
    "src/lib/meeting/screen-observation.service.ts",
    "utf8"
  );

  assert.match(
    source,
    /current product or technical judgment directly with a bounded analysis/i
  );
  assert.match(
    source,
    /only when eligible fact-evidence supports a relevant story/i
  );
  assert.match(
    source,
    /When one reading of the current ask follows the Authorized Evidence, answer it directly/i
  );
  assert.match(source, /a missing personal anchor alone is not enough/i);
  assert.doesNotMatch(source, /If askFrame is ambiguous[\s\S]*do not guess/i);
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
    SCREEN_FOCUSED_CODE_EXPLANATION_INSTRUCTION,
    /capture-time evidence only/i
  );
  assert.match(
    SCREEN_FOCUSED_CODE_EXPLANATION_INSTRUCTION,
    /conditional wording rather than claiming it is current/i
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
