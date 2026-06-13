import assert from "node:assert/strict";
import test from "node:test";
import {
  inferExplicitProgrammingLanguageFromText,
  inferProgrammingLanguageFromCodeFence,
  inferTrustedProgrammingLanguage,
  normalizeProgrammingLanguageName,
} from "../src/lib/meeting/programming-language.js";

test("normalizes common programming language aliases", () => {
  assert.equal(normalizeProgrammingLanguageName("ts"), "TypeScript");
  assert.equal(normalizeProgrammingLanguageName("golang"), "Go");
  assert.equal(normalizeProgrammingLanguageName("cpp"), "C++");
  assert.equal(normalizeProgrammingLanguageName("csharp"), "C#");
});

test("requires explicit wording before inferring language from text", () => {
  assert.equal(
    inferExplicitProgrammingLanguageFromText(
      "The generated answer compares Java and Go tradeoffs."
    ),
    undefined
  );
  assert.equal(
    inferExplicitProgrammingLanguageFromText("Please implement it in Go."),
    "Go"
  );
  assert.equal(
    inferExplicitProgrammingLanguageFromText("Selected language: TypeScript"),
    "TypeScript"
  );
});

test("reads programming language only from code fence labels in generated code", () => {
  assert.equal(
    inferProgrammingLanguageFromCodeFence("Code:\n```java\nclass Solution {}\n```"),
    "Java"
  );
  assert.equal(
    inferProgrammingLanguageFromCodeFence(
      "Answer mentions Python, but no fenced code language."
    ),
    undefined
  );
});

test("prioritizes preflight and explicit constraints over code fences and active task fallback", () => {
  assert.deepEqual(
    inferTrustedProgrammingLanguage({
      screenPreflightLanguage: "Java",
      textHints: ["Please use TypeScript."],
      codeFenceContent: "```python\nprint('x')\n```",
      activeTaskLanguage: "Go",
    }),
    { language: "Java", source: "screen-preflight" }
  );
  assert.deepEqual(
    inferTrustedProgrammingLanguage({
      textHints: ["Please use TypeScript."],
      codeFenceContent: "```python\nprint('x')\n```",
      activeTaskLanguage: "Go",
    }),
    { language: "TypeScript", source: "explicit-text" }
  );
  assert.deepEqual(
    inferTrustedProgrammingLanguage({
      codeFenceContent: "```python\nprint('x')\n```",
      activeTaskLanguage: "Go",
    }),
    { language: "Python", source: "code-fence" }
  );
  assert.deepEqual(
    inferTrustedProgrammingLanguage({
      activeTaskLanguage: "Go",
    }),
    { language: "Go", source: "active-task" }
  );
});
