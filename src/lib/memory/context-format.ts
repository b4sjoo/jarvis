import { resolveRetrievedMemoryRole } from "./runtime-role.js";
import type { RetrievedMemoryEntry } from "./types.js";

export function formatMemoryContext(entries: RetrievedMemoryEntry[]) {
  if (!entries.length) return "No memory context was injected.";

  const roles = ["fact-evidence", "guidance", "template", "overlay"] as const;

  return roles
    .map((role) => {
      const roleEntries = entries.filter(
        (item) => resolveRetrievedMemoryRole(item).role === role
      );
      if (!roleEntries.length) return undefined;

      const formattedEntries = roleEntries.map((item) => {
        const entry = item.entry;
        const runtimeRole = resolveRetrievedMemoryRole(item);
        const lines = [
          `<memory_entry id="${entry.id}" type="${entry.type}" project="${
            entry.projectName || entry.projectId || entry.scope
          }" priority="${entry.priority}" score="${item.score}" runtime_role="${
            runtimeRole.role
          }" anchor_eligible="${runtimeRole.anchorEligible}">`,
          `<title>${entry.title}</title>`,
          entry.summary ? `<summary>${entry.summary}</summary>` : undefined,
          `<content>${item.injectedContent}</content>`,
          `<source_ids>${entry.sourceIds.join(", ")}</source_ids>`,
          `<match_reason>${item.matchReason.join(", ") || "always"}</match_reason>`,
          "</memory_entry>",
        ].filter(Boolean);

        return lines.join("\n");
      });

      return [
        `<memory_group runtime_role="${role}" fact_support="${
          role === "fact-evidence"
        }">`,
        ...formattedEntries,
        "</memory_group>",
      ].join("\n\n");
    })
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}
