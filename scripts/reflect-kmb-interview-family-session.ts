import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  resolveMemoryInterviewFamilyGateDecision,
  type MemoryInterviewFamilyGateDecision,
} from "../src/lib/memory/interview-family.js";
import type {
  MemoryEntry,
  MemoryInterviewType,
  MemoryQuestionType,
  MemoryRetrievalPolicy,
} from "../src/lib/memory/types.js";
import { writeDerivedEvaluationProvenance } from "./lib/derived-evaluation-provenance.js";

interface RecordedMemoryRetrieval {
  source?: string;
  metadata?: {
    questionType?: MemoryQuestionType;
    interviewTypes?: MemoryInterviewType[];
    memoryPolicyId?: string;
    allowedFamilies?: MemoryRetrievalPolicy["allowedFamilies"];
    blockedFamilies?: MemoryRetrievalPolicy["blockedFamilies"];
  };
  memoryContext?: {
    entries?: Array<{ entry?: MemoryEntry }>;
  };
}

interface ReplayEntry {
  recordingFile: string;
  source: string;
  questionType?: MemoryQuestionType;
  entryId: string;
  previousDisposition: "selected";
  replayDisposition: "allow" | "reject";
  rejectReason?: string;
  finalFamilies: string[];
  resolutionReason: string;
  suppressedFamilies: string[];
}

async function main() {
  const { sessionDirectory, outputDirectory } = parseOptions(
    process.argv.slice(2)
  );
  const memoryDirectory = path.join(sessionDirectory, "memory");
  const files = (await readdir(memoryDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const entries: ReplayEntry[] = [];

  for (const file of files) {
    const recording = JSON.parse(
      await readFile(path.join(memoryDirectory, file), "utf8")
    ) as RecordedMemoryRetrieval;
    const policy = buildPolicy(recording);
    for (const item of recording.memoryContext?.entries ?? []) {
      if (!item.entry) continue;
      entries.push(
        toReplayEntry(
          file,
          recording.source ?? "unknown",
          recording.metadata?.questionType,
          item.entry,
          resolveMemoryInterviewFamilyGateDecision({
            entry: item.entry,
            interviewTypes: recording.metadata?.interviewTypes,
            questionType: recording.metadata?.questionType,
            memoryPolicy: policy,
          })
        )
      );
    }
  }

  const report = {
    version: 1,
    sessionId: path.basename(sessionDirectory),
    generatedAt: Date.now(),
    metrics: {
      recordingCount: files.length,
      previouslySelectedCount: entries.length,
      replayAllowedCount: entries.filter(
        (entry) => entry.replayDisposition === "allow"
      ).length,
      replayRejectedCount: entries.filter(
        (entry) => entry.replayDisposition === "reject"
      ).length,
      specificDominanceCount: entries.filter(
        (entry) => entry.suppressedFamilies.length > 0
      ).length,
    },
    entries,
  };

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, "reflection.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(outputDirectory, "reflection.md"),
    renderMarkdown(report),
    "utf8"
  );
  await writeDerivedEvaluationProvenance({
    producer: "reflect-kmb-interview-family-session",
    command: "memory:family:reflect",
    sessionDirectories: [sessionDirectory],
    outputDirectory,
    outputPaths: ["reflection.json", "reflection.md"],
  });
  process.stdout.write(
    `${JSON.stringify({ outputDirectory, ...report.metrics }, null, 2)}\n`
  );
}

function parseOptions(args: string[]) {
  let sessionDirectory: string | undefined;
  let outputDirectory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--session" && args[index + 1]) {
      sessionDirectory = path.resolve(args[index + 1]);
      index += 1;
      continue;
    }
    if (args[index] === "--output" && args[index + 1]) {
      outputDirectory = path.resolve(args[index + 1]);
      index += 1;
    }
  }
  if (!sessionDirectory) {
    throw new Error(
      "Usage: npm run memory:family:reflect -- --session <recording-folder> [--output <folder>]"
    );
  }
  return {
    sessionDirectory,
    outputDirectory:
      outputDirectory ??
      path.join(sessionDirectory, "evaluation", "kmb-interview-family"),
  };
}

function buildPolicy(
  recording: RecordedMemoryRetrieval
): MemoryRetrievalPolicy | undefined {
  const metadata = recording.metadata;
  if (
    !metadata?.memoryPolicyId &&
    !metadata?.allowedFamilies?.length &&
    !metadata?.blockedFamilies?.length
  ) {
    return undefined;
  }
  return {
    id: metadata.memoryPolicyId ?? "recorded-policy",
    allowedFamilies: metadata.allowedFamilies,
    blockedFamilies: metadata.blockedFamilies,
  };
}

function toReplayEntry(
  recordingFile: string,
  source: string,
  questionType: MemoryQuestionType | undefined,
  entry: MemoryEntry,
  decision: MemoryInterviewFamilyGateDecision
): ReplayEntry {
  return {
    recordingFile,
    source,
    questionType,
    entryId: entry.id,
    previousDisposition: "selected",
    replayDisposition: decision.rejectReason ? "reject" : "allow",
    rejectReason: decision.rejectReason,
    finalFamilies: [...decision.resolution.families],
    resolutionReason: decision.resolution.resolutionReason,
    suppressedFamilies: decision.resolution.suppressedEvidence.map(
      (evidence) =>
        `${evidence.family}->${evidence.suppressedBySpecificFamily}`
    ),
  };
}

function renderMarkdown(report: {
  sessionId: string;
  metrics: Record<string, number>;
  entries: ReplayEntry[];
}) {
  const rejected = report.entries.filter(
    (entry) => entry.replayDisposition === "reject"
  );
  return [
    "# KMB Interview-Family Replay",
    "",
    `Session: \`${report.sessionId}\``,
    "",
    "## Metrics",
    "",
    ...Object.entries(report.metrics).map(
      ([name, value]) => `- ${name}: ${value}`
    ),
    "",
    "## Newly Rejected Previously Selected Entries",
    "",
    ...(rejected.length
      ? rejected.map(
          (entry) =>
            `- \`${entry.entryId}\`: ${entry.rejectReason}; families=${entry.finalFamilies.join(",") || "general"}; resolution=${entry.resolutionReason}`
        )
      : ["- None"]),
    "",
  ].join("\n");
}

void main();
