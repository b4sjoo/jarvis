import { AdvisorPromptContext } from "./types";

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

export function buildAdvisorUserMessage(context: AdvisorPromptContext) {
  const latestTurn = context.latestTurn
    ? `${context.latestTurn.speaker}: ${context.latestTurn.text}`
    : "None";

  return [
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
    "<output>",
    "If help is useful, respond in this exact compact format:",
    "Meaning: one short Chinese sentence explaining what the colleague likely means.",
    "Reply: one ready-to-say English sentence, or '-' if no reply is needed.",
    "Question: one safe clarifying question, or '-' if not needed.",
    "If it only contains jargon, put the simple Chinese definition under Meaning and use '-' for Reply and Question.",
    "If no help is needed, output a single dash.",
    "</output>",
  ].join("\n");
}
