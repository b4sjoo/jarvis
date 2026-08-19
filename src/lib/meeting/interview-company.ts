interface CompanyDefinition {
  displayName: string;
  normalized: string;
  aliases: string[];
}

const COMPANY_DEFINITIONS: CompanyDefinition[] = [
  {
    displayName: "Amazon",
    normalized: "amazon",
    aliases: ["amazon", "amazon web services", "aws"],
  },
  {
    displayName: "Microsoft",
    normalized: "microsoft",
    aliases: ["microsoft"],
  },
  {
    displayName: "Google",
    normalized: "google",
    aliases: ["google"],
  },
  {
    displayName: "Meta",
    normalized: "meta",
    aliases: ["meta", "facebook"],
  },
  {
    displayName: "NVIDIA",
    normalized: "nvidia",
    aliases: ["nvidia"],
  },
  {
    displayName: "Apple",
    normalized: "apple",
    aliases: ["apple"],
  },
  {
    displayName: "Netflix",
    normalized: "netflix",
    aliases: ["netflix"],
  },
  {
    displayName: "ByteDance",
    normalized: "bytedance",
    aliases: ["bytedance", "byte dance", "tiktok"],
  },
  {
    displayName: "Airbnb",
    normalized: "airbnb",
    aliases: ["airbnb"],
  },
  {
    displayName: "OpenAI",
    normalized: "openai",
    aliases: ["openai", "open ai"],
  },
  {
    displayName: "Anthropic",
    normalized: "anthropic",
    aliases: ["anthropic"],
  },
  {
    displayName: "Databricks",
    normalized: "databricks",
    aliases: ["databricks"],
  },
  {
    displayName: "Stripe",
    normalized: "stripe",
    aliases: ["stripe"],
  },
  {
    displayName: "Tesla",
    normalized: "tesla",
    aliases: ["tesla"],
  },
  {
    displayName: "xAI",
    normalized: "xai",
    aliases: ["xai", "x ai"],
  },
];

export const INTERVIEW_COMPANY_OPTIONS = COMPANY_DEFINITIONS.map(
  (company) => ({
    value: company.displayName,
    normalized: company.normalized,
  })
);

export function normalizeInterviewBriefCompany(
  companyName: string | undefined
) {
  const trimmed = companyName?.trim();
  if (!trimmed) return undefined;

  const normalizedValue = normalizeForMatching(
    trimmed
      .replace(/['’]s$/i, "")
      .replace(/[.,:;!?]+$/g, "")
  );
  const canonicalCompany = COMPANY_DEFINITIONS.find((company) =>
    company.aliases.some(
      (alias) => normalizeForMatching(alias) === normalizedValue
    )
  );
  if (canonicalCompany) {
    return {
      value: canonicalCompany.displayName,
      normalized: canonicalCompany.normalized,
    };
  }

  const normalized = normalizedValue.replace(/\s+/g, "-");
  return normalized
    ? {
        value: trimmed,
        normalized,
      }
    : undefined;
}

export function getInterviewCompanyEvidenceAliases(
  companyName: string | undefined
) {
  const normalizedCompany = normalizeInterviewBriefCompany(companyName);
  if (!normalizedCompany) return [];
  const definition = COMPANY_DEFINITIONS.find(
    (company) => company.normalized === normalizedCompany.normalized
  );
  return Array.from(
    new Set(
      [companyName, definition?.displayName, ...(definition?.aliases ?? [])]
        .filter((value): value is string => Boolean(value?.trim()))
        .map(normalizeForMatching)
        .filter(Boolean)
    )
  );
}

function normalizeForMatching(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
