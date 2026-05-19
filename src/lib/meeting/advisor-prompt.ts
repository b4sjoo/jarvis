import {
  AdvisorPromptContext,
  AdvisorRequestMode,
  ClarifyingQuestionFeedback,
} from "./types";

export function buildAdvisorSystemPrompt() {
  return [
    "You are a live meeting co-pilot for a non-native English speaker who recently moved into software engineering.",
    "Help the user understand colleagues and respond professionally in software engineering meetings.",
    "Use concise, calm language. Prefer practical suggestions over long explanations.",
    "When the user is likely expected to answer, provide a ready-to-say English reply.",
    "When the situation is unclear, provide a safe clarifying question.",
    "When a technical term or acronym matters, briefly explain it in simple Chinese.",
    "Do not invent colleagues, speakers, questions, intentions, or meeting dialogue that are not present in the transcript or screen context.",
    "If there is screen context but no transcript, treat it as visible screen content only, not as something a colleague said.",
    "If an active screen task is present, use it as the anchor and treat new transcript as clarification or follow-up.",
    "Never claim certainty about facts not present in the transcript or screen context.",
    "For normal meeting help, return at most three short bullets. For screen-anchored tasks, use the requested sections.",
  ].join(" ");
}

interface AdvisorUserMessageOptions {
  mode?: AdvisorRequestMode;
  currentSuggestion?: string;
  clarifyingFeedback?: ClarifyingQuestionFeedback;
}

export function buildAdvisorUserMessage(
  context: AdvisorPromptContext,
  options: AdvisorUserMessageOptions = {}
) {
  const latestTurn = context.latestTurn
    ? `${context.latestTurn.speaker}: ${context.latestTurn.text}`
    : "None";
  const mode = options.mode ?? "live";
  const previousSuggestion = options.currentSuggestion?.trim();
  const hasTranscript = Boolean(context.transcript.trim() || context.latestTurn);
  const hasScreenContext = Boolean(context.screenContext.trim());
  const hasActiveScreenTask = Boolean(context.activeScreenTask);
  const contextMode = hasActiveScreenTask
    ? "screen-anchored"
    : hasTranscript
    ? "transcript-and-screen"
    : hasScreenContext
      ? "screen-only"
      : "empty";

  const sections = [
    "<context_mode>",
    contextMode,
    "</context_mode>",
    "<latest_turn>",
    latestTurn,
    "</latest_turn>",
    "<recent_transcript>",
    context.transcript || "No transcript yet.",
    "</recent_transcript>",
    "<screen_context>",
    context.screenContext || "No screen context.",
    "</screen_context>",
    "<active_screen_task>",
    context.activeScreenTask
      ? formatActiveScreenTask(context.activeScreenTask)
      : "No active screen task.",
    "</active_screen_task>",
    "<rolling_summary>",
    context.rollingSummary || "No summary yet.",
    "</rolling_summary>",
    "<user_context>",
    context.userProfileContext || "No extra user context.",
    "</user_context>",
    "<glossary>",
    context.glossaryText || "No glossary.",
    "</glossary>",
  ];

  if (previousSuggestion) {
    sections.push(
      "<previous_suggestion>",
      previousSuggestion,
      "</previous_suggestion>"
    );
  }

  if (options.clarifyingFeedback) {
    sections.push(
      "<clarifying_feedback>",
      `Question: ${options.clarifyingFeedback.question}`,
      `User selected: ${formatClarifyingAnswer(
        options.clarifyingFeedback.answer
      )}`,
      "</clarifying_feedback>"
    );
  }

  if (mode === "screen-anchored") {
    sections.push(
      "<mode>",
      mode,
      "</mode>",
      "<output>",
      "Update the active screen task using the latest transcript as supplemental clarification or follow-up.",
      "If <clarifying_feedback> is present, treat the user's clicked answer as an explicit constraint.",
      "If the latest transcript adds a constraint, revise the answer accordingly.",
      "If the latest transcript is unrelated, keep the active screen task answer stable and only mention the useful part.",
      "Use this exact format:",
      "Question: focused technical question.",
      "Answer: concise meeting-ready answer or optimal solution summary.",
      "Approach: key reasoning steps.",
      "Code: Python code unless another language is required, or '-' for non-coding tasks.",
      "Complexity: time and space complexity for coding tasks, or '-' otherwise.",
      "Clarifying question: one click-answerable question if a missing constraint matters, otherwise '-'.",
      "Do not invent colleagues, speakers, or hidden requirements.",
      ...buildModeInstructions(mode),
      "</output>"
    );

    return sections.join("\n");
  }

  sections.push(
    "<mode>",
    mode,
    "</mode>",
    "<output>",
    "If help is useful, respond in this exact compact format:",
    hasTranscript
      ? "Meaning: one short Chinese sentence explaining what the latest transcript or visible screen likely means."
      : "Meaning: one short Chinese sentence explaining only what the visible screen shows or implies.",
    "Reply: one ready-to-say English sentence, or '-' if no reply is needed.",
    "Question: one safe clarifying question, or '-' if not needed.",
    "If it only contains jargon, put the simple Chinese definition under Meaning and use '-' for Reply and Question.",
    "Do not mention a colleague, speaker, or someone asking a question unless the transcript explicitly contains that person or question.",
    ...buildContextInstructions(contextMode),
    "If no help is needed, output a single dash.",
    ...buildModeInstructions(mode),
    "</output>"
  );

  return sections.join("\n");
}

function buildContextInstructions(contextMode: string) {
  if (contextMode === "screen-anchored") {
    return [
      "There is an active screen task.",
      "Treat the screen task as the anchor and recent transcript as supplemental context.",
    ];
  }

  if (contextMode === "screen-only") {
    return [
      "There is no transcript in this request.",
      "Base the answer only on <screen_context>.",
      "The screen context may come from the user's configured screenshot auto prompt; preserve that intent.",
      "Use '-' for Reply unless the visible screen clearly asks the user to say something.",
      "Use '-' for Question unless the visible screen itself contains an ambiguity that needs a real follow-up.",
    ];
  }

  return [];
}

function buildModeInstructions(mode: AdvisorRequestMode) {
  if (mode === "screen-only") {
    return [
      "This request was triggered by screen capture only.",
      "Do not infer meeting dialogue from the screenshot.",
    ];
  }

  if (mode === "screen-anchored") {
    return [
      "This request follows an active screen task.",
      "Preserve the task structure unless the latest transcript clearly changes the answer.",
    ];
  }

  if (mode === "clarifying-answer") {
    return [
      "The user clicked a quick answer to your clarifying question.",
      "Use that answer as a strong hint to update the suggested reply.",
      "Do not repeat the same clarifying question; return '-' for Question unless a different follow-up is essential.",
    ];
  }

  if (mode === "regenerate") {
    return [
      "Generate a fresh alternative to any previous suggestion.",
      "Keep the same compact format, but avoid repeating the same wording.",
    ];
  }

  if (mode === "shorter") {
    return [
      "Rewrite the previous suggestion to be shorter.",
      "Keep only the most useful point in each section.",
      "If a section is not essential, return '-' for that section.",
    ];
  }

  return [];
}

function formatActiveScreenTask(
  task: NonNullable<AdvisorPromptContext["activeScreenTask"]>
) {
  return [
    `Kind: ${task.kind}`,
    task.language ? `Language: ${task.language}` : undefined,
    task.question ? `Question: ${task.question}` : undefined,
    "Current answer:",
    task.content,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatClarifyingAnswer(answer: ClarifyingQuestionFeedback["answer"]) {
  if (answer === "yes") return "Yes";
  if (answer === "no") return "No";
  return "Not sure";
}
