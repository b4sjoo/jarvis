#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AUDIO_MANIFEST_FILE = "audio-manifest.json";
const EVENTS_FILE = "events.jsonl";
const REPORT_FILE = "audio-evaluation-report.json";

const finite = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

const identityKey = (payload = {}) =>
  `${payload.captureSessionId ?? "unknown"}:${finite(payload.captureGeneration)}:${finite(payload.segmentSequence)}`;

const overlapMs = (start, end, chunk) =>
  Math.max(0, Math.min(end, finite(chunk.endedAt)) - Math.max(start, finite(chunk.startedAt)));

export function analyzeCallAudioEvidence({ callSessionId, events, audioManifest }) {
  const themChunks = (audioManifest.chunks ?? []).filter(
    (chunk) => chunk.channel === "them"
  );
  const observed = new Map();
  const returned = new Map();
  const rolloverOutcomes = { success: 0, degraded: 0, failed: 0, abandoned: 0 };

  for (const event of events) {
    const payload = event?.payload ?? {};
    if (event?.kind === "audio-segment-observed") {
      observed.set(identityKey(payload), payload);
    }
    if (event?.kind === "stt-operation-returned") {
      returned.set(identityKey(payload), payload);
    }
    if (event?.kind === "rollover-transcript-family") {
      const status = payload.status;
      if (Object.hasOwn(rolloverOutcomes, status)) rolloverOutcomes[status] += 1;
    }
  }

  const segmentEvidence = [...observed.entries()].map(([identity, segment]) => {
    const startedAt = finite(segment.speechStartedAtMs, finite(segment.capturedAtMs));
    const endedAt = finite(
      segment.speechEndedAtMs,
      startedAt + finite(segment.durationMs)
    );
    const durationMs = Math.max(1, endedAt - startedAt);
    const matching = themChunks.filter(
      (chunk) => finite(chunk.captureGeneration) === finite(segment.captureGeneration)
    );
    const coveredMs = Math.min(
      durationMs,
      matching.reduce(
        (total, chunk) => total + overlapMs(startedAt, endedAt, chunk),
        0
      )
    );
    const stt = returned.get(identity);
    const status = !stt
      ? "missing-return"
      : stt.status !== "success"
        ? stt.status
        : String(stt.transcript ?? "").trim()
          ? "success"
          : "empty";
    return {
      identity,
      captureGeneration: finite(segment.captureGeneration),
      segmentSequence: finite(segment.segmentSequence),
      startedAt,
      endedAt,
      durationMs,
      coveredMs,
      coverageRatio: coveredMs / durationMs,
      hasAudioEvidence: coveredMs > 0,
      sttStatus: status,
      transcriptChars: String(stt?.transcript ?? "").length,
    };
  });

  const segmentDurationMs = segmentEvidence.reduce(
    (total, segment) => total + segment.durationMs,
    0
  );
  const coveredDurationMs = segmentEvidence.reduce(
    (total, segment) => total + segment.coveredMs,
    0
  );
  const stt = {
    success: 0,
    empty: 0,
    failed: 0,
    cancelled: 0,
    missingReturn: 0,
    failuresWithAudioEvidence: 0,
  };
  for (const segment of segmentEvidence) {
    if (segment.sttStatus === "success") stt.success += 1;
    else if (segment.sttStatus === "empty") stt.empty += 1;
    else if (segment.sttStatus === "cancelled") stt.cancelled += 1;
    else if (segment.sttStatus === "missing-return") stt.missingReturn += 1;
    else stt.failed += 1;
    if (
      segment.hasAudioEvidence &&
      !["success", "cancelled"].includes(segment.sttStatus)
    ) {
      stt.failuresWithAudioEvidence += 1;
    }
  }

  const channels = Object.fromEntries(
    (audioManifest.channels ?? []).map((channel) => [channel.channel, channel])
  );
  return {
    version: 1,
    callSessionId,
    generatedAt: Date.now(),
    audio: {
      state: audioManifest.state,
      retentionMode: audioManifest.retentionMode,
      chunkCount: (audioManifest.chunks ?? []).length,
      channels,
    },
    metrics: {
      observedSegmentCount: segmentEvidence.length,
      audioBackedSegmentCount: segmentEvidence.filter(
        (segment) => segment.hasAudioEvidence
      ).length,
      segmentDurationMs,
      coveredDurationMs,
      audioCaptureCoverageRatio:
        segmentDurationMs > 0 ? coveredDurationMs / segmentDurationMs : null,
      audioChunkGapCount: Object.values(channels).reduce(
        (total, channel) => total + finite(channel.gapCount),
        0
      ),
      audioWriterOverflowCount: Object.values(channels).reduce(
        (total, channel) => total + finite(channel.overflowCount),
        0
      ),
      stt,
      rolloverOutcomes,
    },
    segments: segmentEvidence,
    missingAudioEvidence: segmentEvidence
      .filter((segment) => !segment.hasAudioEvidence)
      .map((segment) => segment.identity),
  };
}

export function resolveSessionDirectory(input, cwd = process.cwd()) {
  const direct = isAbsolute(input) ? input : resolve(cwd, input);
  if (existsSync(direct)) return direct;
  const appData = resolve(
    homedir(),
    "Library/Application Support/dev.seasonsg.moss/call-session-recordings",
    basename(input)
  );
  if (existsSync(appData)) return appData;
  throw new Error(`Call session folder was not found: ${input}`);
}

export function loadSessionEvidence(sessionDirectory) {
  const audioManifest = JSON.parse(
    readFileSync(resolve(sessionDirectory, AUDIO_MANIFEST_FILE), "utf8")
  );
  const events = readFileSync(resolve(sessionDirectory, EVENTS_FILE), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid events.jsonl line ${index + 1}: ${error.message}`);
      }
    });
  return { audioManifest, events };
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const marker = process.argv.indexOf("--session");
  const input = marker >= 0 ? process.argv[marker + 1] : process.argv[2];
  if (!input) {
    console.error("Usage: npm run audio:analyze -- --session <session-folder-or-path>");
    process.exitCode = 1;
  } else {
    try {
      const sessionDirectory = resolveSessionDirectory(input);
      const evidence = loadSessionEvidence(sessionDirectory);
      const report = analyzeCallAudioEvidence({
        callSessionId: evidence.audioManifest.callSessionId ?? basename(sessionDirectory),
        ...evidence,
      });
      const reportPath = resolve(sessionDirectory, REPORT_FILE);
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.log(JSON.stringify({ reportPath, metrics: report.metrics }, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
