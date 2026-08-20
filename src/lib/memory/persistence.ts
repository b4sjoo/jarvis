import type { MemoryEntry, MemoryInterviewFamily } from "./types.js";

const MEMORY_INTERVIEW_FAMILIES = new Set<MemoryInterviewFamily>([
  "behavioral",
  "coding",
  "system-design",
  "ai-ml-system-design",
  "project-deep-dive",
]);

export type PersistedMemoryInterviewFamiliesStatus =
  | "missing"
  | "explicit"
  | "malformed";

export interface PersistedMemoryInterviewFamiliesDecision {
  status: PersistedMemoryInterviewFamiliesStatus;
  families?: MemoryInterviewFamily[];
  reason?: "invalid-json" | "not-array" | "invalid-family";
}

export function encodePersistedMemoryInterviewFamilies(
  families: MemoryEntry["interviewFamilies"]
): string | null {
  const canonical = dedupeFamilies(families ?? []);
  return canonical.length ? JSON.stringify(canonical) : null;
}

export function decodePersistedMemoryInterviewFamilies(
  value: string | null | undefined
): PersistedMemoryInterviewFamiliesDecision {
  if (!value) return { status: "missing" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { status: "malformed", reason: "invalid-json" };
  }

  if (!Array.isArray(parsed)) {
    return { status: "malformed", reason: "not-array" };
  }
  if (!parsed.length) return { status: "missing" };
  if (
    parsed.some(
      (family) =>
        typeof family !== "string" ||
        !MEMORY_INTERVIEW_FAMILIES.has(family as MemoryInterviewFamily)
    )
  ) {
    return { status: "malformed", reason: "invalid-family" };
  }

  return {
    status: "explicit",
    families: dedupeFamilies(parsed as MemoryInterviewFamily[]),
  };
}

function dedupeFamilies(families: MemoryInterviewFamily[]) {
  return Array.from(new Set(families));
}
