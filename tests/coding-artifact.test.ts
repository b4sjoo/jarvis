import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveCodingArtifactDisplay,
  updateCodingArtifactCache,
} from "../src/lib/meeting/coding-artifact.js";
import {
  buildMeetingAnswerDisplayModel,
  overlayMeetingAnswerArtifacts,
} from "../src/lib/meeting/meeting-answer-display.js";

test("preserves a coding artifact across child follow-ups under one parent", () => {
  const codingSections = sections(
    "Question: Implement a queue.\nAnswer: Use two stacks.\nCode:\n```python\nclass Queue: pass\n```\nComplexity: O(1) amortized"
  );
  const cache = updateCodingArtifactCache({
    activeParentTaskId: "parent_coding",
    activeParentQuestionType: "coding",
    cache: null,
    sections: codingSections,
    sourceParentTaskId: "parent_coding",
    sourceParentQuestionType: "coding",
    sourceSuggestionId: "suggestion_1",
    updatedAt: 100,
  });
  assert.ok(cache);

  const followUpSections = sections(
    "Question: Why is it amortized?\nAnswer: Each item moves at most twice."
  );
  const display = resolveCodingArtifactDisplay({
    activeParentTaskId: "parent_coding",
    activeParentQuestionType: "coding",
    cache,
    sections: followUpSections,
    sourceParentTaskId: "parent_coding",
    sourceParentQuestionType: "coding",
  });

  const projected = projectArtifacts(followUpSections, display);
  assert.equal(projected.code, "class Queue: pass");
  assert.equal(projected.complexity, "O(1) amortized");
  assert.equal(display.isCached, true);
});

test("drops the previous coding artifact at a new parent boundary", () => {
  const oldCache = {
    parentTaskId: "parent_coding",
    parentQuestionType: "coding" as const,
    code: "def solve(): pass",
    complexity: "O(n)",
    updatedAt: 100,
    sourceSuggestionId: "suggestion_old",
  };
  const behavioralSections = sections(
    "Question: Tell me about a conflict.\nAnswer: I aligned the team."
  );

  const nextCache = updateCodingArtifactCache({
    activeParentTaskId: "parent_behavioral",
    activeParentQuestionType: "behavioral",
    cache: oldCache,
    sections: behavioralSections,
    sourceParentTaskId: "parent_behavioral",
    sourceParentQuestionType: "behavioral",
    sourceSuggestionId: "suggestion_new",
    updatedAt: 200,
  });
  const display = resolveCodingArtifactDisplay({
    activeParentTaskId: "parent_behavioral",
    activeParentQuestionType: "behavioral",
    cache: oldCache,
    sections: behavioralSections,
    sourceParentTaskId: "parent_behavioral",
    sourceParentQuestionType: "behavioral",
  });

  assert.equal(nextCache, null);
  const projected = projectArtifacts(behavioralSections, display);
  assert.equal(projected.code, "");
  assert.equal(projected.complexity, "");
  assert.equal(display.isCached, false);
});

test("rejects a stale completed suggestion from the previous parent", () => {
  const oldCache = {
    parentTaskId: "parent_coding",
    parentQuestionType: "coding" as const,
    code: "def old(): pass",
    complexity: "O(1)",
    updatedAt: 100,
  };
  const staleSections = sections(
    "Question: Old coding task.\nAnswer: Old answer.\nCode:\n```python\ndef stale(): pass\n```\nComplexity: O(n)"
  );

  const nextCache = updateCodingArtifactCache({
    activeParentTaskId: "parent_system_design",
    activeParentQuestionType: "general-system-design",
    cache: oldCache,
    sections: staleSections,
    sourceParentTaskId: "parent_coding",
    sourceParentQuestionType: "coding",
    sourceSuggestionId: "suggestion_old",
    updatedAt: 200,
  });
  const display = resolveCodingArtifactDisplay({
    activeParentTaskId: "parent_system_design",
    activeParentQuestionType: "general-system-design",
    cache: oldCache,
    sections: staleSections,
    sourceParentTaskId: "parent_coding",
    sourceParentQuestionType: "coding",
  });

  assert.equal(nextCache, null);
  const projected = projectArtifacts(staleSections, display);
  assert.equal(projected.code, "");
  assert.equal(projected.complexity, "");
  assert.equal(display.isCached, false);
});

test("updates complexity without replacing code for an explicit child improvement", () => {
  const cache = {
    parentTaskId: "parent_coding",
    parentQuestionType: "coding" as const,
    code: "def solve(): pass",
    complexity: "O(n^2)",
    updatedAt: 100,
  };
  const improvementSections = sections(
    "Question: Can you optimize the complexity?\nAnswer: Use a hash map.\nComplexity: O(n) time and O(n) space"
  );

  const nextCache = updateCodingArtifactCache({
    activeParentTaskId: "parent_coding",
    activeParentQuestionType: "coding",
    cache,
    sections: improvementSections,
    sourceParentTaskId: "parent_coding",
    sourceParentQuestionType: "coding",
    sourceSuggestionId: "suggestion_2",
    updatedAt: 200,
  });

  assert.ok(nextCache);
  assert.equal(nextCache.code, "def solve(): pass");
  assert.equal(nextCache.complexity, "O(n) time and O(n) space");
});

test("drops coding artifacts when a parent is retyped in place", () => {
  const cache = {
    parentTaskId: "parent_shared",
    parentQuestionType: "coding" as const,
    code: "def solve(): pass",
    complexity: "O(n)",
    updatedAt: 100,
  };
  const staleCodingSections = sections(
    "Question: Implement it.\nAnswer: Use a scan.\nCode:\n```python\ndef stale(): pass\n```\nComplexity: O(n)"
  );

  const nextCache = updateCodingArtifactCache({
    activeParentTaskId: "parent_shared",
    activeParentQuestionType: "behavioral",
    cache,
    sections: staleCodingSections,
    sourceParentTaskId: "parent_shared",
    sourceParentQuestionType: "coding",
    sourceSuggestionId: "suggestion_before_retype",
    updatedAt: 200,
  });
  const display = resolveCodingArtifactDisplay({
    activeParentTaskId: "parent_shared",
    activeParentQuestionType: "behavioral",
    cache,
    sections: staleCodingSections,
    sourceParentTaskId: "parent_shared",
    sourceParentQuestionType: "coding",
  });

  assert.equal(nextCache, null);
  const projected = projectArtifacts(staleCodingSections, display);
  assert.equal(projected.code, "");
  assert.equal(projected.complexity, "");
  assert.equal(display.isCached, false);
});

test("preserves a coding child artifact while its system-design parent is stable", () => {
  const codingChildSections = sections(
    "Question: Implement the loss.\nAnswer: Use cross entropy.\nCode:\n```python\ndef loss(): pass\n```\nComplexity: O(n)"
  );
  const cache = updateCodingArtifactCache({
    activeParentTaskId: "parent_aiml",
    activeParentQuestionType: "ai-ml-system-design",
    cache: null,
    sections: codingChildSections,
    sourceParentTaskId: "parent_aiml",
    sourceParentQuestionType: "ai-ml-system-design",
    sourceSuggestionId: "suggestion_coding_child",
    updatedAt: 100,
  });
  assert.ok(cache);

  const display = resolveCodingArtifactDisplay({
    activeParentTaskId: "parent_aiml",
    activeParentQuestionType: "ai-ml-system-design",
    cache,
    sections: sections(
      "Question: Why cross entropy?\nAnswer: It matches the likelihood objective."
    ),
    sourceParentTaskId: "parent_aiml",
    sourceParentQuestionType: "ai-ml-system-design",
  });

  const projected = projectArtifacts(
    sections(
      "Question: Why cross entropy?\nAnswer: It matches the likelihood objective."
    ),
    display
  );
  assert.equal(projected.code, "def loss(): pass");
  assert.equal(projected.complexity, "O(n)");
  assert.equal(display.isCached, true);
});

function sections(content: string) {
  return buildMeetingAnswerDisplayModel({ content });
}

function projectArtifacts(
  answer: ReturnType<typeof sections>,
  artifacts: ReturnType<typeof resolveCodingArtifactDisplay>
) {
  return overlayMeetingAnswerArtifacts(answer, {
    whiteboard: { kind: "preserve" },
    code: artifacts.code,
    complexity: artifacts.complexity,
  });
}
