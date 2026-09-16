import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (value) => createHash("sha256").update(value).digest("hex");
export const defaultSessions = [
  "session-2026-09-15T19-14-33-511Z_8oehk8", "session-2026-09-15T20-33-03-034Z_pg0oli",
  "session-2026-09-15T21-32-35-681Z_62xm1q", "session-2026-09-15T21-36-53-554Z_c8cjp9",
  "session-2026-09-15T22-44-03-429Z_nph7uz", "session-2026-09-15T09-01-35-609Z_sr5prv",
  "session-2026-09-15T18-10-47-845Z_z1nkf5",
];

function loadCurrentRule() {
  const source = readFileSync(join(root, "src/lib/meeting/sentence-completion-buffer.ts"), "utf8");
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { module, exports: module.exports });
  return { ...module.exports, sourceHash: hash(source) };
}

export function readIngressSource(trace) {
  const ingress = trace.steps?.find((step) => step.name === "Canonical turn ingress admitted");
  if (!ingress) return undefined;
  const metadata = { ...trace.metadata, ...ingress.metadata };
  const ingressAt = metadata.canonicalTurnIngressEnteredAt;
  const turnId = metadata.canonicalTurnIngressTurnId;
  if (metadata.canonicalTurnIngressSpeaker !== "them" || !turnId || !Number.isFinite(ingressAt)) return undefined;
  const candidates = [...(trace.outputs ?? []), ...(trace.inputs ?? [])].filter((entry) =>
    typeof entry.value === "string" && Number.isFinite(entry.recordedAt) && entry.recordedAt <= ingressAt &&
    (entry.label === "runtime regression text input" ||
      (entry.label === "display transcript final" && entry.metadata?.displayTranscriptSemanticCommitAuthorized === true &&
        entry.metadata?.displayTranscriptUtteranceId === turnId)));
  const source = candidates.sort((a, b) => b.recordedAt - a.recordedAt)[0];
  return { traceId: trace.id, turnId, ingressAt, text: source?.value,
    runtimeSessionId: metadata.canonicalTurnIngressSessionId,
    runtimeEpoch: metadata.canonicalTurnIngressRuntimeEpoch,
    textSource: source?.label, evidenceGaps: source ? [] : ["exact-at-ingress-text-unavailable"],
    metadata, steps: trace.steps ?? [] };
}

export function auditRows(rows, rule) {
  const ordered = [...rows].sort((a, b) => a.ingressAt - b.ingressAt || a.traceId.localeCompare(b.traceId));
  const byTrace = new Map(ordered.map((row) => [`${row.folder}/${row.traceId}`, row]));
  const inventory = ordered.map((row) => {
    const firstHold = row.steps.find((step) => step.name === "Sentence completion fragment buffered");
    const fragmentIds = firstHold?.metadata?.sentenceBufferTraceIds;
    const decisionAt = firstHold?.startedAt ?? row.ingressAt;
    const parts = Array.isArray(fragmentIds) ? fragmentIds.map((id) => byTrace.get(`${row.folder}/${id}`)) : [row];
    const completeParts = parts.length > 0 && parts.every((part) => part?.text && part.ingressAt <= decisionAt);
    const decisionText = completeParts ? rule.mergeSentenceFragments(parts.map((part) => part.text)) : row.text;
    // A single original fragment retains its ellipsis; merging removes only the
    // already-arrived predecessor's tail punctuation in the production path.
    const exactDecisionText = parts.length === 1 ? row.text : completeParts ? decisionText : undefined;
    const replay = exactDecisionText ? rule.decideSentenceCompletion(exactDecisionText) : undefined;
    return { ...row, text: row.text, decisionText: exactDecisionText, decisionAt,
      episodeId: row.metadata.sentenceBufferOperationId ?? `bypass:${row.turnId}`,
      recordedDisposition: row.metadata.sentenceBufferDisposition,
      recordedReason: firstHold?.metadata?.sentenceBufferReason ?? row.metadata.sentenceBufferReason,
      recordedOutcome: row.metadata.sentenceBufferOutcome,
      recordedWaitMs: row.metadata.sentenceBufferAddedLatencyMs,
      heldAt: firstHold?.startedAt,
      bufferDeadlineAt: row.metadata.sentenceBufferDeadlineAt ?? row.metadata.sentenceBufferContinuationDeadlineAt,
      replay: replay && { disposition: replay.disposition, reason: replay.reason, evidence: replay.evidence },
      evidenceGaps: [...row.evidenceGaps, ...(!exactDecisionText ? ["decision-text-unavailable"] : [])],
    };
  });
  const groups = new Map();
  for (const row of inventory) {
    const key = `${row.folder}/${row.episodeId}`;
    const group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
  }
  const cases = [...groups].map(([id, group]) => {
    const first = group[0];
    const terminal = [...group].reverse().find((row) => row.recordedOutcome && row.metadata.sentenceBufferOperationRole === "terminal");
    const sameSession = inventory.filter((row) => row.folder === first.folder && row.runtimeSessionId === first.runtimeSessionId);
    const past = sameSession.filter((row) => row.ingressAt < first.ingressAt && row.text).slice(-3);
    let budget = 600;
    const priorContext = past.reverse().flatMap((row) => {
      const text = row.text.slice(-budget); budget -= text.length;
      return text ? [{ speaker: "them", text, ingressAt: row.ingressAt }] : [];
    }).reverse();
    const later = sameSession.filter((row) => row.ingressAt > first.ingressAt && row.ingressAt <= first.ingressAt + 15_000 && row.text).slice(0, 2);
    return { id, folder: first.folder, traceIds: group.map((row) => row.traceId),
      first, fragmentCount: group.length, waitMs: terminal?.recordedWaitMs,
      outcome: terminal?.recordedOutcome, priorContext, continuation: later.map((row) => ({ text: row.text, afterMs: row.ingressAt - first.ingressAt, turnId: row.turnId })),
      humanReview: { status: "unconfirmed", sufficientAtFirstIngress: null, continuationRelated: null, addedNecessaryInformation: null },
    };
  });
  return { inventory, cases };
}

const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] : null;
const countBy = (rows, key) => Object.fromEntries([...new Set(rows.map(key))].sort().map((name) => [name, rows.filter((row) => key(row) === name).length]));
const quote = (text) => String(text ?? "[source unavailable]").split("\n").map((line) => `> ${line}`).join("\n");

export function selectBlindCases(cases, limit = 40) {
  const eligible = cases.filter((item) => item.first.text).sort((a, b) => hash(a.id).localeCompare(hash(b.id)));
  const buffered = (item) => !item.first.episodeId.startsWith("bypass:");
  const selected = [...eligible.filter(buffered).slice(0, limit / 2), ...eligible.filter((item) => !buffered(item)).slice(0, limit / 2)];
  const ids = new Set(selected.map((item) => item.id));
  for (const item of eligible) {
    if (selected.length >= limit) break;
    if (!ids.has(item.id)) { selected.push(item); ids.add(item.id); }
  }
  return selected.sort((a, b) => hash(a.id).localeCompare(hash(b.id)));
}

export function runBufferAudit({ recordingsRoot, outputDir, sessions = defaultSessions }) {
  const sourceRoot = resolve(recordingsRoot), destination = resolve(outputDir);
  if (destination === sourceRoot || destination.startsWith(sourceRoot + "/")) throw new Error("Output must be outside original recordings");
  const rule = loadCurrentRule();
  const all = [], manifests = [], sourceHashes = [], missing = [];
  for (const folder of sessions) {
    if (!/^session-[A-Za-z0-9_.-]+$/.test(folder)) throw new Error("Session folder names only");
    const directory = join(sourceRoot, folder);
    let manifest;
    try { const raw = readFileSync(join(directory, "manifest.json"), "utf8"); manifest = JSON.parse(raw); sourceHashes.push({ path: `${folder}/manifest.json`, sha256: hash(raw) }); }
    catch (error) { missing.push({ folder, reason: error.code ?? "manifest-invalid" }); continue; }
    manifests.push({ folder, build: manifest.build, declaredCollection: manifest.scriptedValidation === true ? "scripted" : "organic",
      reviewContext: defaultSessions.includes(folder)
        ? defaultSessions.indexOf(folder) >= 5 ? "user-reported-short-validation" : "user-reported-onsite" : "not-specified",
      status: manifest.status, integrity: manifest.recordingIntegrity });
    for (const name of readdirSync(join(directory, "traces")).filter((name) => name.endsWith(".json")).sort()) {
      const raw = readFileSync(join(directory, "traces", name), "utf8");
      let envelope;
      try { envelope = JSON.parse(raw); }
      catch { missing.push({ folder, path: name, reason: "invalid-trace-json" }); continue; }
      const trace = envelope.trace ?? envelope;
      const row = readIngressSource(trace);
      if (!row) continue;
      sourceHashes.push({ path: `${folder}/traces/${name}`, sha256: hash(raw) });
      all.push({ ...row, folder });
    }
  }
  // Dedup the physical source identity, not text similarity. Keep the earliest
  // available envelope and flag duplicate source exports rather than mixing revisions.
  const unique = new Map();
  let duplicates = 0;
  for (const row of all.sort((a, b) => a.ingressAt - b.ingressAt)) {
    const key = `${row.folder}/${row.runtimeSessionId}/${row.runtimeEpoch}/${row.turnId}`;
    if (unique.has(key)) { duplicates++; continue; }
    unique.set(key, row);
  }
  const { inventory, cases } = auditRows([...unique.values()], rule);
  const order = selectBlindCases(cases);
  const waits = cases.map((item) => item.waitMs).filter((value) => Number.isFinite(value) && value >= 0);
  const summary = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), ruleSourceHash: rule.sourceHash,
    sourceManifestHash: hash(JSON.stringify(sourceHashes)), sessions: manifests, missing,
    sourceCount: inventory.length, episodeCount: cases.length, duplicateSourceExports: duplicates,
    exactReplayCount: inventory.filter((row) => row.replay).length,
    missingExactTextCount: inventory.filter((row) => !row.decisionText).length,
    recordedDispositions: countBy(inventory, (row) => row.recordedDisposition ?? "not-observed"),
    replayReasons: countBy(inventory, (row) => row.replay?.reason ?? "unavailable"),
    episodeOutcomes: countBy(cases, (row) => row.outcome ?? "bypass-or-no-terminal"),
    measuredEpisodeWaits: { count: waits.length, p50: percentile(waits, 0.5), p95: percentile(waits, 0.95), max: waits.length ? Math.max(...waits) : null },
    confirmedSemanticLabels: 0, precision: null, recall: null, providerCalls: 0,
    blindReviewCases: order.length,
    blindSelection: "Up to40 exact-text cases;20 buffered and20 bypass by stable identity hash, spare slots borrowed. Full inventory is retained; this sample is not an unweighted population-accuracy denominator.",
    limitations: ["Captured Them ingress only; missing audio and missing STT are not silence labels.",
      "Rule confidence constants are not probabilities. Operational merge/timeout counts are not accuracy.",
      "Different build/declared collection and user-reported test purpose remain separate.",
      "Current-rule text replay does not rerun RO, Type, Relation or Advisor and cannot prove answer quality.",
      "Stage1 contains only past input; Stage2 is separate and may contain future continuation. Prior captured context is not an exact reproduced model prompt.",
      "No old Human Expected or original recording is modified. All semantic labels require human confirmation."],
  };
  mkdirSync(destination, { recursive: true });
  const write = (name, value) => writeFileSync(join(destination, name), value, { flag: "wx", mode: 0o600 });
  write("manifest.json", JSON.stringify({ ...summary, sourceHashes }, null, 2) + "\n");
  write("inventory.jsonl", inventory.map(({ metadata, steps, ...row }) => JSON.stringify(row)).join("\n") + "\n");
  write("episodes.jsonl", cases.map(({ first, ...row }) => JSON.stringify({ ...row, firstTraceId: first.traceId })).join("\n") + "\n");
  write("blind-stage1.md", "# Buffer Review: Stage1\n\nJudge only whether the available input already permits a useful response. No decisions below are pre-labeled.\n\n" + order.map((item, i) =>
    `## Case ${i + 1}\n\nPrior available Them context:\n\n${item.priorContext.map((row) => quote(row.text)).join("\n\n") || "None captured."}\n\nCurrent source:\n\n${quote(item.first.text)}\n\nSufficient for a useful response: [unconfirmed]\nReason: [unconfirmed]\n`).join("\n"));
  write("blind-stage2.md", "# Buffer Review: Stage2\n\nOpen only after Stage1 judgments are fixed. Later input is not evidence available at the first decision.\n\n" + order.map((item, i) =>
    `## Case ${i + 1}\n\n${item.continuation.map((row) => `After ${row.afterMs}ms:\n${quote(row.text)}`).join("\n\n") || "No following Them input captured within15 seconds."}\n\nSame request / necessary addition / earliest useful response: [unconfirmed]\n`).join("\n"));
  write("case-key.json", JSON.stringify(order.map((item, i) => ({ case: i + 1, id: item.id, folder: item.folder, traceIds: item.traceIds,
    originalRule: item.first.recordedReason, currentRule: item.first.replay, waitMs: item.waitMs, outcome: item.outcome,
    evidenceGaps: item.first.evidenceGaps })), null, 2) + "\n");
  write("summary.json", JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--root", "--output"].includes(args[i]) || !args[i + 1]) throw new Error("Usage: --root RECORDINGS --output NEW_PRIVATE_DIRECTORY");
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options.root || !options.output) throw new Error("Both --root and --output are required");
  console.log(JSON.stringify(runBufferAudit({ recordingsRoot: options.root, outputDir: options.output }), null, 2));
}
