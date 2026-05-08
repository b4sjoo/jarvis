import { AdvisorPromptContext, AdvisorRequestMode } from "./types";

export function buildAdvisorSystemPrompt() {
  return [
    "You are a live meeting co-pilot for a non-native English speaker who recently moved into software engineering.",
    "Help the user understand colleagues and respond professionally in software engineering meetings.",
    "Use concise, calm language. Prefer practical suggestions over long explanations.",
    "When the user is likely expected to answer, provide a ready-to-say English reply.",
    "When the situation is unclear, provide a safe clarifying question.",
    "When a technical term or acronym matters, briefly explain it in simple Chinese.",
    "Never claim certainty about facts not present in the transcript or screen context.",
    "Return at most three bullets. Each bullet should be short.",
  ].join(" ");
}

interface AdvisorUserMessageOptions {
  mode?: AdvisorRequestMode;
  currentSuggestion?: string;
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

  const sections = [
    "<latest_turn>",
    latestTurn,
    "</latest_turn>",
    "<recent_transcript>",
    context.transcript || "No transcript yet.",
    "</recent_transcript>",
    "<screen_context>",
    context.screenContext || "No screen context.",
    "</screen_context>",
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

  sections.push(
    "<mode>",
    mode,
    "</mode>",
    "<output>",
    "If help is useful, respond in this exact compact format:",
    "Meaning: one short Chinese sentence explaining what the colleague likely means.",
    "Reply: one ready-to-say English sentence, or '-' if no reply is needed.",
    "Question: one safe clarifying question, or '-' if not needed.",
    "If it only contains jargon, put the simple Chinese definition under Meaning and use '-' for Reply and Question.",
    "If no help is needed, output a single dash.",
    ...buildModeInstructions(mode),
    "</output>"
  );

  return sections.join("\n");
}

function buildModeInstructions(mode: AdvisorRequestMode) {
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
