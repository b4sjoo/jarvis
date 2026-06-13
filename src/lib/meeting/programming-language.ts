export type ProgrammingLanguageSource =
  | "screen-preflight"
  | "explicit-text"
  | "code-fence"
  | "active-task";

export interface ProgrammingLanguageInference {
  language?: string;
  source?: ProgrammingLanguageSource;
}

const LANGUAGE_ALIASES: Array<[RegExp, string]> = [
  [/^(?:typescript|type\s*script|ts)$/i, "TypeScript"],
  [/^(?:javascript|java\s*script|js)$/i, "JavaScript"],
  [/^(?:python|py)$/i, "Python"],
  [/^(?:java)$/i, "Java"],
  [/^(?:go|golang)$/i, "Go"],
  [/^(?:c\+\+|cpp)$/i, "C++"],
  [/^(?:c#|csharp|c\s*sharp)$/i, "C#"],
  [/^(?:rust|rs)$/i, "Rust"],
  [/^(?:kotlin|kt)$/i, "Kotlin"],
  [/^(?:swift)$/i, "Swift"],
];

const LANGUAGE_TOKEN_PATTERN =
  "(typescript|type\\s*script|ts|javascript|java\\s*script|js|python|py|java|go|golang|c\\+\\+|cpp|c#|csharp|c\\s*sharp|rust|rs|kotlin|kt|swift)";

const EXPLICIT_LANGUAGE_PATTERNS = [
  new RegExp(
    `\\b(?:use|using|write|solve|implement|code|answer)\\s+(?:it\\s+)?(?:in|with|using)?\\s*(?:${LANGUAGE_TOKEN_PATTERN})\\b`,
    "i"
  ),
  new RegExp(
    `\\b(?:in|with|using)\\s+(?:${LANGUAGE_TOKEN_PATTERN})\\s+(?:please|code|solution|implementation|language)?\\b`,
    "i"
  ),
  new RegExp(
    `\\b(?:language|lang|selected\\s+language|programming\\s+language|language\\s+dropdown|language\\s+tab|language\\s+option)\\s*(?:is|=|:)?\\s*(?:${LANGUAGE_TOKEN_PATTERN})\\b`,
    "i"
  ),
];

const CODE_FENCE_PATTERN = /```([a-zA-Z0-9+#.-]+)/;

export function normalizeProgrammingLanguageName(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) return undefined;

  for (const [pattern, language] of LANGUAGE_ALIASES) {
    if (pattern.test(normalized)) return language;
  }

  return undefined;
}

export function inferExplicitProgrammingLanguageFromText(
  text: string | undefined
) {
  if (!text?.trim()) return undefined;

  for (const pattern of EXPLICIT_LANGUAGE_PATTERNS) {
    const match = pattern.exec(text);
    const languageToken = match?.slice(1).find(Boolean);
    const language = normalizeProgrammingLanguageName(languageToken);
    if (language) return language;
  }

  return undefined;
}

export function inferProgrammingLanguageFromCodeFence(
  content: string | undefined
) {
  const fenceLanguage = CODE_FENCE_PATTERN.exec(content ?? "")?.[1];
  return normalizeProgrammingLanguageName(fenceLanguage);
}

export function inferTrustedProgrammingLanguage({
  screenPreflightLanguage,
  textHints = [],
  codeFenceContent,
  activeTaskLanguage,
}: {
  screenPreflightLanguage?: string;
  textHints?: Array<string | undefined>;
  codeFenceContent?: string;
  activeTaskLanguage?: string;
}): ProgrammingLanguageInference {
  const preflightLanguage = normalizeProgrammingLanguageName(
    screenPreflightLanguage
  );
  if (preflightLanguage) {
    return { language: preflightLanguage, source: "screen-preflight" };
  }

  for (const hint of textHints) {
    const explicitLanguage = inferExplicitProgrammingLanguageFromText(hint);
    if (explicitLanguage) {
      return { language: explicitLanguage, source: "explicit-text" };
    }
  }

  const codeFenceLanguage = inferProgrammingLanguageFromCodeFence(
    codeFenceContent
  );
  if (codeFenceLanguage) {
    return { language: codeFenceLanguage, source: "code-fence" };
  }

  const existingLanguage = normalizeProgrammingLanguageName(activeTaskLanguage);
  if (existingLanguage) {
    return { language: existingLanguage, source: "active-task" };
  }

  return {};
}
