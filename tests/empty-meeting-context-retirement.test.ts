import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { buildAdvisorUserMessage } from "../src/lib/meeting/advisor-prompt.js";
import { buildSpeechBiasContext } from "../src/lib/meeting/speech-bias.js";
import { buildAdvisorEvidencePacket } from "../src/lib/meeting/advisor-evidence-packet.js";
import { loadScreenTaskPromptBuilder } from "./helpers/screen-task-prompt-builder.js";

for (const parent of [false, true]) {
  test(`live Meeting context has no empty legacy plumbing; authorized evidence retained, parent=${parent}`, () => {
    const manager = new MeetingContextManager();
    manager.reset({ sessionId: "empty-plumbing-test" });
    if (parent) {
      assert.equal(manager.commitTaskRuntimeTransition({ id: "seed", transition: "create-parent", reason: "fixture",
        parent: { id: "p", source: "voice", stableKind: "general-system-design", topic: "Design the queue",
          playbookPhase: "design_framing", revisions: 1, phaseProgress: {}, supportedFactAnchors: [], createdAt: 1, updatedAt: 1 } }).authorized, true);
    }
    const base = manager.buildAdvisorPromptContext();
    for (const key of ["rollingSummary", "userProfileContext", "glossary", "glossaryText", "responseOnlyParentReadContext"]) {
      assert.equal(key in base, false);
      assert.equal(key in manager.getState(), false);
    }
    const before = manager.getState();
    const packet = buildAdvisorEvidencePacket({ currentQuestion: { source: "voice-lqu", text: "Explain queue isolation.", sourceTurnIds: ["t"] },
      activeMeetingTask: base.activeMeetingTask });
    const voice = buildAdvisorUserMessage({ ...base, transcript: "Them: Explain queue isolation.",
      memoryContext: "VERIFIED_MEMORY_FACT", advisorEvidencePacket: packet });
    const screen = loadScreenTaskPromptBuilder()({ observation: { id: "image", capturedAt: 1, source: "hotkey", changed: true,
      visualSummary: "Visible queue diagram", imageBase64: "fixture" }, memoryContext: "VERIFIED_MEMORY_FACT", advisorEvidencePacket: packet });
    for (const prompt of [voice, screen]) {
      assert.doesNotMatch(prompt, /<(?:rolling_summary|user_context|glossary|response_only_parent_read_context)>/);
      assert.match(prompt, /VERIFIED_MEMORY_FACT/);
      assert.match(prompt, /Explain queue isolation/);
      if (parent) assert.match(prompt, /Design the queue/);
    }
    const bias = buildSpeechBiasContext(before, [], [{ canonicalTerm: "Valkey", aliases: ["val key"],
      statementId: "term", statementRevision: 1, authority: "user-confirmed" }]);
    assert.ok(bias.terms.some(term => term.term === "Valkey" && term.source === "preparation"));
    assert.deepEqual(manager.getState(), before);
  });
}

test("the obsolete response-only scope file is retired, not replaced by a compatibility wrapper", () => {
  assert.equal(existsSync("src/lib/meeting/response-only-task-scope.ts"), false);
});
