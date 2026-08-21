import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { CURATED_MEMORY_DRAFT_PATHS } from "../src/lib/memory/curated-draft-paths.js";
import {
  auditCuratedMemoryEvidence,
  renderKmbEvidenceAuditMarkdown,
} from "../src/lib/memory/evidence-audit.js";
import { parseCuratedMemoryDrafts } from "../src/lib/memory/parser.js";

async function main() {
  const outputBase = readOutputBase(process.argv.slice(2));
  const drafts = await Promise.all(
    CURATED_MEMORY_DRAFT_PATHS.map(async (draftPath) => ({
      path: draftPath,
      content: await readFile(path.resolve(draftPath), "utf8"),
    }))
  );
  const report = auditCuratedMemoryEvidence({
    drafts: parseCuratedMemoryDrafts(drafts),
  });
  await mkdir(path.dirname(outputBase), { recursive: true });
  await Promise.all([
    writeFile(
      `${outputBase}.json`,
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    ),
    writeFile(
      `${outputBase}.md`,
      renderKmbEvidenceAuditMarkdown(report),
      "utf8"
    ),
  ]);
  process.stdout.write(
    `Audited ${report.entryCount} entries across ${report.draftCount} drafts: ${report.issueCounts.error} errors, ${report.issueCounts.warning} warnings.\n`
  );
  if (report.issueCounts.error > 0) process.exitCode = 1;
}

function readOutputBase(argv: string[]) {
  const index = argv.indexOf("--output");
  if (index < 0) {
    return path.resolve("docs", "kmb-evidence-audit.latest");
  }
  const value = argv[index + 1]?.trim();
  if (!value) throw new Error("--output requires a path without an extension.");
  return path.resolve(value.replace(/\.(?:json|md)$/i, ""));
}

main().catch((error) => {
  process.stderr.write(
    `KMB evidence audit failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
