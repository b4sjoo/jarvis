import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProductionRuntime } from "./calibrate-question-type.mjs";
import { defaultSessions } from "./audit-sentence-buffer.mjs";

const hash = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const kinds = ["question-type-adjudication", "task-relation-parent-affinity", "task-relation-child-affinity", "task-relation-canonical-shadow"];
const inputLabels = ["question type adjudication model input", "parent affinity model input", "child affinity model input", "task relation split canonical model input"];
const outputLabels = ["question type adjudication raw output", "parent affinity raw output", "child affinity raw output", "task relation split canonical raw output"];

export function requestFromSavedPrompt({ runtime, operationKind, promptText, traceId, metadata = {} }) {
  const splitAt = promptText.lastIndexOf("\n\n{");
  if (splitAt < 0) throw new Error("Saved semantic payload is missing");
  const payload = JSON.parse(promptText.slice(splitAt + 2));
  let request;
  if (operationKind === "question-type-adjudication") {
    if (!Array.isArray(payload.question?.sourceTexts)) throw new Error("Not a Broad Type payload");
    request = runtime.makeRequest({ text: payload.question.sourceTexts.join("\n") });
    request.question.sourceTurns = payload.question.sourceTexts.map((text, index) => ({
      ...request.question.sourceTurns[0], turnId: `offline-source-${index}`, text,
    }));
    request.structuredHints = payload.nonAuthoritativeHints;
  } else {
    request = { operationKind, affinityKind: operationKind === "task-relation-child-affinity" ? "child" : "parent",
      schemaVersion: operationKind === "task-relation-canonical-shadow" ? 3 : 1,
      promptVersion: metadata.promptVersion ?? "recorded-onsite-input",
      identity: { sessionId: "offline-only", runtimeEpoch: 1,
        logicalQuestionUnitId: `offline:${traceId}`, logicalQuestionRevision: 1,
        parentId: "offline-parent", parentRevision: 1, manualCorrectionRevision: 0 },
      semanticPayload: payload, semanticPayloadDigest: metadata.semanticPayloadDigest ?? hash(payload) };
  }
  const prompts = runtime.prompts(request);
  if (`${prompts.systemPrompt}\n\n${prompts.userMessage}`.trim() !== promptText.trim()) {
    throw new Error("Current prompt differs from the saved model-visible input");
  }
  return request;
}

export function preparePilot({ recordingsRoot, outputFile }) {
  const sourceRoot = resolve(recordingsRoot), output = resolve(outputFile);
  if (output.startsWith(sourceRoot + "/")) throw new Error("Never write inside original recordings");
  const runtimes = Object.fromEntries(kinds.map((operationKind) => [operationKind, createProductionRuntime({ cap: 1024, operationKind })]));
  const candidates = [], gaps = [], labelAvailability = [];
  for (const folder of defaultSessions.slice(0, 5)) {
    const directory = join(sourceRoot, folder);
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    const compatibility = JSON.parse(readFileSync(join(directory, "evaluation/human-evaluation-v2/compatibility.json"), "utf8"));
    labelAvailability.push({ folder, recordedTypeLabelCount: compatibility.dimensions?.questionType?.v2Labeled ?? null });
    for (const filename of readdirSync(join(directory, "traces")).filter((name) => name.endsWith(".json")).sort()) {
      const raw = readFileSync(join(directory, "traces", filename), "utf8");
      const trace = JSON.parse(raw).trace;
      if (!trace) continue;
      for (let index = 0; index < kinds.length; index++) {
        const operationKind = kinds[index];
        if (index === 0 && (trace.kind !== "voice" || trace.metadata?.canonicalTurnIngressSpeaker !== "them")) continue;
        const inputs = trace.inputs?.filter((item) => item.label === inputLabels[index]) ?? [];
        let outputs = trace.outputs?.filter((item) => item.label === outputLabels[index]) ?? [];
        let outputSource;
        if (outputs.length === 0) {
          const relativeDir = `${folder}/traces/${filename.slice(0, -5)}/outputs`;
          try {
            const slug = outputLabels[index].replaceAll(" ", "-") + ".md";
            const names = readdirSync(join(sourceRoot, relativeDir)).filter((name) => name.endsWith(`-${slug}`));
            if (names.length === 1) {
              const value = readFileSync(join(sourceRoot, relativeDir, names[0]), "utf8");
              outputs = [{ value }];
              outputSource = { path: `${relativeDir}/${names[0]}`, sha256: hash(value) };
            }
          } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        // A repeated-input trace needs a separate attempt join, not a guessed pairing.
        if (inputs.length !== 1 || outputs.length !== 1 || typeof inputs[0].value !== "string") continue;
        const input = inputs[0], recordedOutput = outputs[0];
        try {
          const request = requestFromSavedPrompt({ runtime: runtimes[operationKind], operationKind,
            promptText: input.value, traceId: trace.id, metadata: input.metadata });
          const parsed = runtimes[operationKind].parse(recordedOutput.value, request);
          candidates.push({ id: `${folder}/${trace.id}/${operationKind}`, folder, traceId: trace.id, operationKind,
            sourcePath: `${folder}/traces/${filename}`, sourceHash: hash(raw), outputSource, build: manifest.build,
            promptHash: hash(input.value), promptText: input.value, request,
            originalPrediction: parsed.ok ? parsed.value : null,
            originalParseDisposition: parsed.ok ? "valid" : parsed.reason,
            humanTruth: null, humanTruthEvidence: compatibility.dimensions?.questionType?.v2Labeled === 0
              ? "no-recorded-Type-ground-truth-in-session" : "requires-exact-subject-join-before-semantic-scoring" });
        } catch (error) { gaps.push({ folder, traceId: trace.id, operationKind, reason: error.message }); }
      }
    }
  }
  const ordered = [...candidates].sort((a, b) => hash(a.id).localeCompare(hash(b.id)));
  const typeSamples = [];
  for (const type of ["coding", "field-knowledge", "behavioral", "project-deep-dive", "general-system-design", "ai-ml-system-design"]) {
    const sample = ordered.find((item) => item.operationKind === kinds[0] && item.originalPrediction?.questionType === type);
    if (sample) typeSamples.push({ ...sample, samplingStratum: `recorded-prediction:${type}` });
  }
  for (const sample of ordered) {
    if (typeSamples.length >= 6) break;
    if (sample.operationKind === kinds[0] && !typeSamples.some((item) => item.id === sample.id)) typeSamples.push({ ...sample, samplingStratum: "remaining-ordinary-voice-by-hash" });
  }
  const relationSamples = kinds.slice(1).map((operationKind) => {
    const sample = ordered.find((item) => item.operationKind === operationKind && !item.originalPrediction)
      ?? ordered.find((item) => item.operationKind === operationKind);
    return sample && { ...sample, samplingStratum: "historical-invalid-output-preferred" };
  }).filter(Boolean);
  if (typeSamples.length !== 6 || relationSamples.length !== 3) throw new Error(JSON.stringify({
    reason: "Insufficient matched samples for the frozen18-call pilot", typeSamples: typeSamples.length,
    relationSamples: relationSamples.map((item) => item.operationKind), eligibleInputs: candidates.length, gaps: gaps.slice(0, 4) }));
  const samples = [...typeSamples, ...relationSamples];
  const manifest = { schemaVersion: 1, frozenAt: new Date().toISOString(),
    inputHash: hash(samples), maxHttpRequests: 18, maxOperations: 18, repeatsPerCell: 1,
    typeComparison: { cases: 6, tiers: ["fast", "intelligent"], maxOutputTokens: 1024, timeoutMs: 4000, singleAttempt: true },
    relationComparison: { cases: 3, tier: "intelligent", caps: [512, 1024], providerTimeoutsMs: { affinity: 7000, canonical: 6000 }, singleAttempt: true },
    sourceModules: Object.fromEntries(kinds.map((kind) => [kind, runtimes[kind].sources])),
    configState: "pending-current-provider-freeze", executionState: "not-run", providerCalls: 0,
    labelAvailability, gaps, eligibleInputs: candidates.length, samples,
    limits: ["No Advisor, RO, STT, Hook orchestration, actual lifecycle or original-recording writes.",
      "Type first-attempt comparison omits retry deadlines in both arms to enforce the18-HTTP-request cap; it is not a full production retry replay.",
      "Historical predictions only stratify sampling; they are never human ground truth.",
      "Relation samples favor historical invalid outputs and cannot estimate general truncation probability.",
      "Provider budgets are not the same as available foreground time. Timely-usefulness requires the separate original scheduling evidence.",
      "No production Type route switch is authorized. Stop on auth/config failure; no automatic reruns or extra sampling."] };
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o400 });
  return { inputHash: manifest.inputHash, samples: samples.map(({ id, samplingStratum, originalPrediction }) => ({ id, samplingStratum, originalPrediction })), eligibleInputs: candidates.length, gaps: gaps.length, maxHttpRequests: 18 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [recordingsRoot, outputFile] = process.argv.slice(2);
  if (!recordingsRoot || !outputFile) throw new Error("Usage: RECORDINGS_ROOT NEW_PRIVATE_MANIFEST.json");
  console.log(JSON.stringify(preparePilot({ recordingsRoot, outputFile }), null, 2));
}
