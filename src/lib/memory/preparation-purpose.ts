import type { MemoryEntry, PreparationRetrievalPurpose } from "./types.js";
import { classifyRuntimeMemoryRole } from "./runtime-role.js";

// Retrieval grouping is descriptive and never changes runtime fact authority.
export function preparationMemoryPurpose(entry: MemoryEntry): PreparationRetrievalPurpose {
  return entry.type === "profile" || entry.type === "preference" ||
    classifyRuntimeMemoryRole(entry).role === "fact-evidence"
    ? "personal-context"
    : "guidance";
}
