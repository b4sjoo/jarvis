import assert from "node:assert/strict";
import test from "node:test";
import { buildAdvisorSystemPrompt, buildAdvisorUserMessage } from "../src/lib/meeting/advisor-prompt.js";
import { SCREEN_TASK_SYSTEM_PROMPT } from "../src/lib/meeting/screen-task-system-prompt.js";
import { formatMeetingResponseLanguage, MEETING_RESPONSE_LANGUAGE_POLICY } from "../src/lib/meeting/response-language.js";
import { loadScreenTaskPromptBuilder } from "./helpers/screen-task-prompt-builder.js";
import { selectInterviewPlaybook } from "../src/lib/meeting/interview-playbook.js";
import { decidePlaybookPhaseProgression } from "../src/lib/meeting/playbook-phase.js";

const screen = loadScreenTaskPromptBuilder();
for (const type of ["project-deep-dive", "behavioral", "coding"] as const) {
  for (const language of ["chinese", "english", "auto"] as const) {
    test(`NL ${type}/${language}: Voice and Screen share prose preference without changing phase`, () => {
      const question = type === "coding" ? "Implement an LRUCache in Python."
        : type === "behavioral" ? "Tell me about a conflict at work." : "Introduce Agentic Memory.";
      const playbook = selectInterviewPlaybook({ questionType: type, query: question });
      assert.ok(playbook);
      const phase = decidePlaybookPhaseProgression({ questionType: type, currentQuestion: question,
        currentPhase: playbook.phase });
      const prior = JSON.stringify({ playbook, phase });
      const voice = buildAdvisorUserMessage({ transcript: `Them: ${question}`, screenContext: "",
          taskRuntime: { revision: 0 }, interviewPlaybook: playbook,
        playbookPhaseDecision: phase }, { responseConfig: { language, length: "normal" } });
      const visual = screen({ observation: { id: "screen", capturedAt: 1, summary: question },
        recentTranscript: question, screenPreflight: { question, questionType: type }, interviewPlaybook: playbook,
        playbookPhaseDecision: phase, responseConfig: { language, length: "normal" } });
      for (const [system, user] of [[buildAdvisorSystemPrompt(), voice], [SCREEN_TASK_SYSTEM_PROMPT, visual]]) {
        assert.ok(system.includes(MEETING_RESPONSE_LANGUAGE_POLICY));
        assert.ok(user.includes(formatMeetingResponseLanguage(language)));
        assert.doesNotMatch(user, /in English|English answer|English question|English bullets|not Chinese|canonical profile explicitly requires meeting-ready English/);
        assert.match(user, /中文思路:/);
      }
      assert.equal(JSON.stringify({ playbook, phase }), prior);
      assert.match(visual, /selected\/requested language, or Python/);
      assert.match(SCREEN_TASK_SYSTEM_PROMPT, /brute force or exhaustive enumeration/);
      assert.match(SCREEN_TASK_SYSTEM_PROMPT, /highlighted or selected code block/);
    });
  }
}
