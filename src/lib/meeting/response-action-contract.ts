import type {
  AdvisorContextScopeSnapshot,
  MeetingAnswerProfile,
  MeetingResponseActionMode,
} from "./types.js";

export function buildResponseActionInstructions(
  action: MeetingResponseActionMode,
  profile: MeetingAnswerProfile
) {
  if (action === "speakable") {
    return [
      "Action goal: produce a speakable answer the user can say out loud.",
      profile === "compact-spoken"
        ? "Keep Answer to one to three short professional English sentences."
        : "Keep the active technical profile and make Answer easy to say aloud without dropping required artifacts.",
      "Use '-' for Clarifying question unless a missing constraint truly blocks a reliable answer.",
      "For coding suggestions, put speakable wording in Answer and Approach while preserving Code and Complexity.",
      "For coding suggestions, keep Answer, Approach, Complexity, and clarifying text in meeting-ready English while 中文思路 remains Chinese.",
      "Avoid adding new code blocks outside the Code section. Mention complexity only when it is central to the answer.",
    ];
  }

  if (action === "narrow-context") {
    return [
      "Action goal: regenerate from only the current source-owned logical question and any directly bound screen/correction evidence.",
      "Exclude previous parent narrative, previous child narrative, broad transcript history, rolling summaries, cached artifacts, and generated answers.",
      "Preserve the same parent identity, canonical question type, relation, and playbook phase.",
      "Do not describe the Narrow action in the answer.",
    ];
  }

  if (action === "enhance-context") {
    return [
      "Action goal: regenerate with the smallest source-backed context selected in <response_action_context_scope>.",
      "Use only the selected recent dialogue or source-only parent/child capsules. Never treat generated answers, compact summaries, Code, Whiteboard, or memory payloads as source authority.",
      "Preserve the same parent identity, canonical question type, relation, and playbook phase.",
      "Do not describe the Enhance action in the answer.",
    ];
  }

  if (action === "regenerate-artifacts") {
    return [
      "Action goal: replace only the Artifact family authorized in <playbook_phase_state> for the visible Answer owner.",
      "Do not change the visible Answer, Question, Approach, Clarifying question, task identity, relation, or playbook phase.",
      "For Design, emit one complete replacement Whiteboard. For Coding, emit complete Code and exact Complexity together.",
      "Existing Artifacts are continuity for a full replacement, not evidence that changes the interview question.",
      "For Coding, retain the source-backed class, function, language, signature, and return contract. Do not invent project modules or files; a single-file implementation may include a standard-library test or demonstration entry point when the request asks for tests.",
      "Do not describe the Regenerate Artifacts action in the generated sections.",
    ];
  }

  if (action === "previous-phase") {
    return [
      "Action goal: answer for the deterministically restored previous playbook phase of the same parent task.",
      "Do not create, retype, or re-parent a task. Do not roll back Code or Whiteboard artifacts.",
      "Continue from the restored phase rather than narrating the Back control.",
      "Keep the active canonical answer profile.",
    ];
  }

  return [
    "Action goal: manually advance the current active task to the next useful playbook phase.",
    "Preserve the same active parent task. Do not create a new task, restart the playbook, or repeat generic requirement clarification unless a blocking requirement is truly missing.",
    "Use <active_meeting_task>, <interview_playbook>, <playbook_phase_state>, and <previous_suggestion> to infer the next useful phase.",
    "If previous phase information is incomplete, make reasonable assumptions briefly and continue instead of asking a generic setup question.",
    "For general-system-design or ai-ml-system-design, prefer moving toward architecture, Whiteboard, scale/QPS, metrics, evaluation, reliability, or the next subsystem rather than re-asking scope.",
    "For project-deep-dive, prefer moving from overview to hard problem, tradeoff, validation/debugging, impact, or lesson.",
    "For behavioral answers, prefer deepening the selected STAR story with action, tradeoff, impact, or lesson; do not invent a new story.",
    "For coding suggestions, keep the required screen-task section labels and move toward implementation details, edge cases, correctness proof, or complexity while preserving Code and Complexity.",
    "For coding suggestions, keep Answer, Approach, Complexity, and clarifying text in meeting-ready English while 中文思路 remains Chinese.",
    "Keep the active canonical answer profile. Do not change profile because the task was seeded by voice or screen.",
  ];
}

export function formatResponseActionContextScope(
  scope: AdvisorContextScopeSnapshot | undefined
) {
  if (!scope) return "Default context scope.";
  return [
    `Operation id: ${scope.operationId}`,
    `Action: ${scope.action}`,
    `Mode: ${scope.mode}`,
    `Logical question: ${scope.logicalQuestionUnitId} revision ${scope.logicalQuestionUnitRevision}`,
    `Selected source kinds: ${scope.selectedContextSourceKinds.join(", ") || "current-question"}`,
    `Selected turn ids: ${scope.selectedContextTurnIds.join(", ") || "none"}`,
    `Selected context chars: ${scope.selectedContextChars}`,
    `Expansion budget: ${scope.expansionBudget}`,
    `Selection reason: ${scope.selectionReason}`,
  ].join("\n");
}
