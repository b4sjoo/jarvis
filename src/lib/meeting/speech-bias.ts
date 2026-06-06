import type {
  MeetingContextState,
  SpeechBiasContext,
  SpeechBiasTerm,
  SpeechCorrection,
  SpeechCorrectionRule,
  SpeechNormalizationResult,
} from "./types";
import { createMeetingId } from "./context-manager";

const MAX_BIAS_TERMS = 24;
const MAX_PROMPT_CHARS = 900;

const AI_ML_DOMAIN_TERMS = [
  "RAG",
  "Retrieval-Augmented Generation",
  "LLM",
  "embedding",
  "vector database",
  "model serving",
  "inference",
  "evaluation",
];

const AGENTIC_DOMAIN_TERMS = [
  "agentic memory",
  "agent",
  "tool use",
  "planner",
  "workflow",
  "memory base",
];

const SEARCH_DOMAIN_TERMS = [
  "OpenSearch",
  "NeuralSearch",
  "semantic search",
  "ranking",
  "retrieval",
  "vector search",
];

const KNOWN_TECH_TERMS = [
  "AOS",
  "AWS",
  "Glean",
  "OpenAI",
  "Anthropic",
  "OpenSearch",
  "NeuralSearch",
  "BeagleStone",
  "Agentic Memory",
  "Model Interface",
  "RAG",
  "Retrieval-Augmented Generation",
  "LLM",
  "KMB",
  "MCP",
];

export function buildSpeechBiasContext(
  context: MeetingContextState,
  corrections: SpeechCorrection[]
): SpeechBiasContext {
  const terms: SpeechBiasTerm[] = [];
  const addTerm = (
    term: string | undefined,
    source: SpeechBiasTerm["source"],
    weight: SpeechBiasTerm["weight"] = "normal"
  ) => {
    const normalized = normalizeTerm(term);
    if (!normalized) return;

    const existing = terms.find(
      (candidate) => candidate.term.toLowerCase() === normalized.toLowerCase()
    );
    if (existing) {
      if (weight === "high") existing.weight = "high";
      return;
    }

    terms.push({ term: normalized, source, weight });
  };

  addTerm(context.interviewSessionBrief?.targetCompany, "brief", "high");
  addTerm(context.interviewSessionContext?.targetCompany?.value, "brief", "high");

  for (const term of extractLikelyTerms(
    [
      context.interviewSessionBrief?.focusAreas,
      context.interviewSessionBrief?.notes,
    ].join("\n")
  )) {
    addTerm(term, "brief", "high");
  }

  for (const entry of context.glossary) {
    addTerm(entry.term, "glossary", "high");
  }

  const activeTask = context.activeScreenTask;
  if (activeTask) {
    addTerm(activeTask.classifier?.projectAnchor, "active-task", "high");
    for (const term of extractLikelyTerms(
      [
        activeTask.question,
        activeTask.content.slice(0, 1200),
        activeTask.classifier?.projectAnchor,
      ].join("\n")
    )) {
      addTerm(term, "active-task", "high");
    }

    if (activeTask.classifier?.topicDomain === "ai-ml-infra") {
      for (const term of AI_ML_DOMAIN_TERMS) addTerm(term, "domain");
    } else if (activeTask.classifier?.topicDomain === "agentic-ai") {
      for (const term of AGENTIC_DOMAIN_TERMS) addTerm(term, "domain");
    } else if (activeTask.classifier?.topicDomain === "search") {
      for (const term of SEARCH_DOMAIN_TERMS) addTerm(term, "domain");
    }
  }

  for (const turn of context.transcriptTurns.slice(-6)) {
    for (const term of extractLikelyTerms(turn.text)) {
      addTerm(term, "transcript");
    }
  }

  for (const correction of corrections) {
    addTerm(correction.to ?? correction.term, "correction", "high");
  }

  const correctionRules = buildCorrectionRules(terms, corrections);
  const prompt = buildSpeechPrompt(terms, correctionRules);

  return {
    terms: terms
      .sort((left, right) => {
        if (left.weight !== right.weight) return left.weight === "high" ? -1 : 1;
        return left.term.localeCompare(right.term);
      })
      .slice(0, MAX_BIAS_TERMS),
    correctionRules,
    prompt,
  };
}

export function parseEmergencySpeechCorrection(
  input: string
): SpeechCorrection | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const explicitMatch = trimmed.match(
    /^(.+?)\s+(?:not|instead of|rather than)\s+(.+?)$/i
  );
  if (explicitMatch) {
    const to = normalizeTerm(explicitMatch[1]);
    const from = normalizeCorrectionSide(explicitMatch[2]);
    if (!to || !from) return null;

    return {
      id: createMeetingId("speech_correction"),
      input: trimmed,
      term: to,
      from,
      to,
      createdAt: Date.now(),
      appliedCount: 0,
    };
  }

  const arrowMatch = trimmed.match(/^(.+?)\s*(?:->|=>)\s*(.+?)$/);
  if (arrowMatch) {
    const from = normalizeCorrectionSide(arrowMatch[1]);
    const to = normalizeTerm(arrowMatch[2]);
    if (!to || !from) return null;

    return {
      id: createMeetingId("speech_correction"),
      input: trimmed,
      term: to,
      from,
      to,
      createdAt: Date.now(),
      appliedCount: 0,
    };
  }

  const term = normalizeTerm(trimmed);
  if (!term) return null;

  return {
    id: createMeetingId("speech_correction"),
    input: trimmed,
    term,
    to: term,
    createdAt: Date.now(),
    appliedCount: 0,
  };
}

export function normalizeTranscriptWithSpeechBias(
  text: string,
  bias: SpeechBiasContext
): SpeechNormalizationResult {
  let normalized = text;
  const appliedRules: SpeechCorrectionRule[] = [];

  for (const rule of bias.correctionRules) {
    const next = replacePhrasePreservingSpacing(normalized, rule.from, rule.to);
    if (next !== normalized) {
      normalized = next;
      appliedRules.push(rule);
    }
  }

  return {
    text: normalized,
    changed: normalized !== text,
    appliedRules,
  };
}

export function formatSpeechBiasPromptForTrace(bias: SpeechBiasContext) {
  if (!bias.terms.length) return "No speech bias terms.";

  return [
    bias.prompt,
    "",
    "Terms:",
    ...bias.terms.map(
      (term) => `- ${term.term} (${term.source}, ${term.weight})`
    ),
    "",
    "Correction rules:",
    ...(bias.correctionRules.length
      ? bias.correctionRules.map(
          (rule) => `- ${rule.from} -> ${rule.to} (${rule.reason})`
        )
      : ["- none"]),
  ].join("\n");
}

function buildCorrectionRules(
  terms: SpeechBiasTerm[],
  corrections: SpeechCorrection[]
) {
  const rules: SpeechCorrectionRule[] = [];

  for (const correction of corrections) {
    if (correction.from && correction.to) {
      rules.push({
        from: correction.from,
        to: correction.to,
        source: "emergency",
        reason: "manual correction",
      });
    }
  }

  if (hasStrongTerm(terms, "RAG")) {
    rules.push({
      from: "rec",
      to: "RAG",
      source: "bias",
      reason: "strong RAG context",
    });
    rules.push({
      from: "rack",
      to: "RAG",
      source: "bias",
      reason: "strong RAG context",
    });
  }

  if (hasStrongTerm(terms, "Glean")) {
    rules.push({
      from: "clean",
      to: "Glean",
      source: "bias",
      reason: "strong Glean context",
    });
  }

  return dedupeRules(rules);
}

function buildSpeechPrompt(
  terms: SpeechBiasTerm[],
  rules: SpeechCorrectionRule[]
) {
  const preferredTerms = terms
    .filter((term) => term.weight === "high")
    .concat(terms.filter((term) => term.weight !== "high"))
    .slice(0, MAX_BIAS_TERMS)
    .map((term) => term.term);

  if (!preferredTerms.length) return "";

  const correctionHint = rules.length
    ? ` Corrections: ${rules
        .slice(0, 6)
        .map((rule) => `"${rule.from}" means "${rule.to}"`)
        .join("; ")}.`
    : "";

  return truncateText(
    `Likely technical terms, company names, product names, and acronyms: ${preferredTerms.join(
      ", "
    )}. Preserve acronyms and product names exactly.${correctionHint}`,
    MAX_PROMPT_CHARS
  );
}

function extractLikelyTerms(text: string) {
  const terms = new Set<string>();
  const normalized = text || "";

  for (const term of KNOWN_TECH_TERMS) {
    if (new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(normalized)) {
      terms.add(term);
    }
  }

  const acronymMatches = normalized.match(/\b[A-Z][A-Z0-9+#.]{1,}\b/g) ?? [];
  for (const match of acronymMatches) terms.add(match);

  const projectMatches =
    normalized.match(/\b[A-Z][A-Za-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g) ?? [];
  for (const match of projectMatches) terms.add(match);

  if (/\bretrieval[-\s]?augmented generation\b/i.test(normalized)) {
    terms.add("RAG");
    terms.add("Retrieval-Augmented Generation");
  }

  return Array.from(terms);
}

function hasStrongTerm(terms: SpeechBiasTerm[], term: string) {
  return terms.some(
    (candidate) =>
      candidate.term.toLowerCase() === term.toLowerCase() &&
      candidate.weight === "high" &&
      candidate.source !== "domain"
  );
}

function replacePhrasePreservingSpacing(text: string, from: string, to: string) {
  if (!from.trim() || !to.trim()) return text;
  const pattern = new RegExp(`\\b${escapeRegExp(from.trim())}\\b`, "gi");
  return text.replace(pattern, to);
}

function normalizeTerm(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 80) return undefined;

  const normalized = trimmed
    .replace(/^[\s"'`.,:;!?]+|[\s"'`.,:;!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || undefined;
}

function normalizeCorrectionSide(value: string | undefined) {
  return normalizeTerm(value)?.toLowerCase();
}

function dedupeRules(rules: SpeechCorrectionRule[]) {
  const map = new Map<string, SpeechCorrectionRule>();
  for (const rule of rules) {
    const key = `${rule.from.toLowerCase()}->${rule.to.toLowerCase()}`;
    if (!map.has(key)) map.set(key, rule);
  }
  return Array.from(map.values());
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars).trimEnd();
}
