import fs from "node:fs";
import path from "node:path";

const TOP_LEVEL_KEYS = new Set(["$schema", "version", "updatedAt", "entries"]);
const ENTRY_KEYS = new Set([
  "id",
  "symbolOrSurface",
  "verdict",
  "ownerTaskId",
  "replacement",
  "persistedDataImpact",
  "historicalReader",
  "proofCommands",
  "deletionGate",
  "rollbackBoundary",
  "status",
  "forbiddenPatterns",
]);
const VERDICTS = new Set(["delete", "migrate-then-delete", "keep-boundary"]);
const DATA_IMPACTS = new Set(["none", "settings", "database", "recording"]);
const STATUSES = new Set(["candidate", "migration-ready", "deleted", "retained"]);
const PRIVATE_VALUE_PATTERNS = [
  /\/Users\//i,
  /(?:^|\/)memories\//i,
  /session-20\d\d-/i,
  /(?:api[_-]?key|authorization|bearer)\s*[:=]/i,
];

export const DEFAULT_DELETION_LEDGER_PATH = path.join(
  "architecture",
  "deletion-ledger.json"
);

export function loadDeletionLedger(
  repositoryRoot = process.cwd(),
  ledgerPath = DEFAULT_DELETION_LEDGER_PATH
) {
  const absolutePath = path.resolve(repositoryRoot, ledgerPath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
}

export function validateDeletionLedger(ledger) {
  const errors = [];
  if (!isObject(ledger)) {
    return result(["ledger must be an object"], []);
  }

  reportUnknownKeys(ledger, TOP_LEVEL_KEYS, "ledger", errors);
  if (ledger.version !== 1) errors.push("ledger.version must equal 1");
  if (!isDateOnly(ledger.updatedAt)) {
    errors.push("ledger.updatedAt must use YYYY-MM-DD");
  }
  if (!Array.isArray(ledger.entries)) {
    errors.push("ledger.entries must be an array");
    return result(errors, []);
  }

  const ids = new Set();
  for (const [index, entry] of ledger.entries.entries()) {
    const label = `entries[${index}]`;
    if (!isObject(entry)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    reportUnknownKeys(entry, ENTRY_KEYS, label, errors);
    requireSlug(entry.id, `${label}.id`, errors);
    requireString(entry.symbolOrSurface, `${label}.symbolOrSurface`, errors);
    requireEnum(entry.verdict, VERDICTS, `${label}.verdict`, errors);
    if (!Number.isInteger(entry.ownerTaskId) || entry.ownerTaskId < 1) {
      errors.push(`${label}.ownerTaskId must be a positive integer`);
    }
    requireEnum(
      entry.persistedDataImpact,
      DATA_IMPACTS,
      `${label}.persistedDataImpact`,
      errors
    );
    requireString(entry.deletionGate, `${label}.deletionGate`, errors);
    requireString(entry.rollbackBoundary, `${label}.rollbackBoundary`, errors);
    requireEnum(entry.status, STATUSES, `${label}.status`, errors);
    requireStringArray(entry.proofCommands, `${label}.proofCommands`, errors);

    if (entry.id && ids.has(entry.id)) {
      errors.push(`${label}.id duplicates ${entry.id}`);
    }
    ids.add(entry.id);

    if (entry.verdict === "migrate-then-delete") {
      requireString(entry.replacement, `${label}.replacement`, errors);
    }
    if (entry.verdict === "keep-boundary") {
      requireString(entry.historicalReader, `${label}.historicalReader`, errors);
    }
    if (entry.status === "deleted") {
      requireStringArray(
        entry.forbiddenPatterns,
        `${label}.forbiddenPatterns`,
        errors
      );
    } else if (entry.forbiddenPatterns !== undefined) {
      requireStringArray(
        entry.forbiddenPatterns,
        `${label}.forbiddenPatterns`,
        errors
      );
    }

    for (const [key, value] of Object.entries(entry)) {
      for (const text of flattenStrings(value)) {
        if (PRIVATE_VALUE_PATTERNS.some((pattern) => pattern.test(text))) {
          errors.push(`${label}.${key} contains private or secret-like data`);
          break;
        }
      }
    }
  }

  return result(errors, ledger.entries);
}

function result(errors, entries) {
  const statusCounts = Object.fromEntries(
    [...STATUSES].map((status) => [status, 0])
  );
  for (const entry of entries) {
    if (entry && STATUSES.has(entry.status)) statusCounts[entry.status] += 1;
  }
  return {
    ok: errors.length === 0,
    errors,
    entryCount: entries.length,
    statusCounts,
  };
}

function reportUnknownKeys(value, allowed, label, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
  }
}

function requireSlug(value, label, errors) {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    errors.push(`${label} must be a lowercase kebab-case identifier`);
  }
}

function requireString(value, label, errors) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${label} must be a non-empty string`);
  }
}

function requireEnum(value, values, label, errors) {
  if (!values.has(value)) {
    errors.push(`${label} must be one of ${[...values].join(", ")}`);
  }
}

function requireStringArray(value, label, errors) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    errors.push(`${label} must be a non-empty string array`);
  }
}

function isDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function flattenStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  return [];
}
