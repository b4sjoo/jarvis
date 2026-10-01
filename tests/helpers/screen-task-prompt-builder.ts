import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { formatAdvisorEvidencePacketForPrompt } from "../../src/lib/meeting/advisor-evidence-packet.js";
import { formatInterviewSessionBriefForPrompt, formatInterviewSessionContextForPrompt } from "../../src/lib/meeting/interview-session-context.js";
import { formatInterviewPlaybookForPrompt, withInterviewPlaybookPhase } from "../../src/lib/meeting/interview-playbook.js";
import { formatFactAnchorDecisionForPrompt, PROJECT_FACT_RESPONSE_BOUNDARY } from "../../src/lib/meeting/fact-anchor-guardrail.js";
import { formatProjectBindingDecisionForPrompt } from "../../src/lib/meeting/project-binding.js";
import { formatPlaybookPhaseDecisionForPrompt } from "../../src/lib/meeting/playbook-phase.js";
import { formatCapacityEstimationGuardrailForPrompt, resolveCapacityEstimationGuardrail } from "../../src/lib/meeting/capacity-estimation-guardrail.js";
import { SCREEN_FOCUSED_CODE_EXPLANATION_INSTRUCTION } from "../../src/lib/meeting/screen-task-system-prompt.js";
import { formatMeetingResponseLanguage } from "../../src/lib/meeting/response-language.js";

// Execute production composition with real pure dependencies, without loading
// native capture or provider code from the service's module initialization.
export function loadScreenTaskPromptBuilder() {
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
  return vm.runInNewContext(ts.transpileModule([
    ...declarations, "buildScreenTaskUserMessage",
  ].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, {
    formatAdvisorEvidencePacketForPrompt, formatInterviewSessionBriefForPrompt,
    formatInterviewSessionContextForPrompt, formatInterviewPlaybookForPrompt,
    withInterviewPlaybookPhase, formatFactAnchorDecisionForPrompt,
    PROJECT_FACT_RESPONSE_BOUNDARY,
    formatProjectBindingDecisionForPrompt, formatPlaybookPhaseDecisionForPrompt,
    formatCapacityEstimationGuardrailForPrompt,
    resolveCapacityEstimationGuardrail, SCREEN_FOCUSED_CODE_EXPLANATION_INSTRUCTION, formatMeetingResponseLanguage,
  }) as (input: Record<string, unknown>) => string;
}
