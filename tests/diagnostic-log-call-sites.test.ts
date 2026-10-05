// Task 178 LG, commits 2 and 3: the field ledger of the logger call sites (LG4) and
// the loss counters the Hook hands to the panel.
//
// The ledger table is DIAGNOSTIC_LOG_LEDGER in tests/helpers/diagnostic-log-spy.ts,
// so that every call-site test checks its entries against the same rows. This
// file requires that table to be complete: each `logDiagnostic(` call in src is
// in one of its rows, and each row is one such call, or the two calls on two
// branches that make the same entry.
//
// Real: the Hook and trace store source, read as text and as a syntax tree, and the
// logger leaf that each spy evaluates. Controlled: the logger's delivery boundary,
// timers, clock and console (see the helper). Each call site is driven through its
// own production code in the test file of its harness:
//   formal Relation, observation stage, Type window  tests/ordered-relation-publication-callback.test.mjs
//   Advisor                                           tests/main-advisor-waiting-budget.test.ts
//   Fact Risk Review                                  tests/fact-risk-review.test.ts
//   Meeting Metadata inference                        tests/recording-inference-admission.test.ts
//   Whiteboard repair                                 tests/whiteboard-shadow-consumer.test.ts
//   the migrated call sites of commit 3               tests/diagnostic-log-migration.test.ts and the files it names
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as leaf from "../src/lib/meeting/diagnostic-log.js";
import {
  CAUSE_CHARS,
  CAUSE_LIMIT,
  DIAGNOSTIC_LOG_LEDGER,
  DIAGNOSTIC_LOG_NOT_GRADED,
  DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES,
  DIAGNOSTIC_LOG_SPY_LEVELS,
  NO_CAUSE_ON_PROVIDER_PATH,
  PLANTED_VALUES,
  assertEntryInLedger,
  assertNothingPlanted,
  createDiagnosticLogSpy,
  listDiagnosticLogCallSites,
} from "./helpers/diagnostic-log-spy.js";

const HOOK = "src/hooks/useMeetingAssistant.ts";
const TRACE_STORE = "src/lib/meeting/trace.ts";
const hookText = readFileSync(HOOK, "utf8");
const hook = ts.createSourceFile("hook.ts", hookText, ts.ScriptTarget.Latest, true);
const key = (row: { file: string; owner: string; source: string; event: string }) => `${row.file} ${row.owner} ${row.source} ${row.event}`;

test("LG4 ledger completeness: every logDiagnostic call in src is in one ledger row and every row is its one call, or the two branches it states, with literal tags, a lazy detail and no await", () => {
  const sites = listDiagnosticLogCallSites("src");
  // A row stands for one call, or for the number of calls of its owner that it states.
  assert.deepEqual(sites.map(key).sort(), DIAGNOSTIC_LOG_LEDGER.flatMap((row) => Array.from({ length: row.callSites ?? 1 }, () => key(row))).sort());
  assert.equal(new Set(DIAGNOSTIC_LOG_LEDGER.map((row) => `${row.source} ${row.event}`)).size, DIAGNOSTIC_LOG_LEDGER.length,
    "a source and event pair names one row");
  // One entry is made on two branches: a capture start that failed, in the catch of the start and on the branch that
  // blocks it for a missing speech-to-text provider (decisions A8, item 5).
  assert.deepEqual(DIAGNOSTIC_LOG_LEDGER.filter((row) => row.callSites !== undefined).map((row) => [`${row.source} ${row.event}`, row.owner, row.callSites]),
    [["meeting.capture start-failed", "startCapture", 2]]);
  for (const site of sites) {
    const label = `${site.file}:${site.line} ${site.source} ${site.event}`;
    assert.match(site.source, /^[a-z0-9.-]{1,48}$/, `${label}: the source is a literal tag`);
    assert.match(site.event, /^[a-z0-9.-]{1,64}$/, `${label}: the event is a literal tag`);
    assert.equal(site.lazyDetail, true, `${label}: the detail is a function, so a filtered call builds nothing`);
    assert.equal(site.awaited, false, `${label}: the call is not awaited`);
  }
  // The logger is called in src by the Hook and by the trace store alone, and each takes it from the module directly:
  // it is not passed through a business dependency.
  assert.deepEqual([...new Set(sites.map((site) => site.file))], [HOOK, TRACE_STORE]);
  for (const [file, specifier, text] of [[HOOK, '"@/lib/meeting/diagnostic-log"', hookText],
    [TRACE_STORE, '"./diagnostic-log.js"', readFileSync(TRACE_STORE, "utf8")]] as const) {
    const source = file === HOOK ? hook : ts.createSourceFile("trace.ts", text, ts.ScriptTarget.Latest, true);
    const named = source.statements.filter(ts.isImportDeclaration).filter((node) =>
      node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.some((element) => element.name.text === "logDiagnostic"));
    assert.deepEqual(named.map((node) => node.moduleSpecifier.getText(source)), [specifier], file);
    const mentions: ts.Identifier[] = [];
    const visit = (node: ts.Node) => { if (ts.isIdentifier(node) && node.text === "logDiagnostic") mentions.push(node); ts.forEachChild(node, visit); };
    visit(source);
    assert.equal(mentions.length, sites.filter((site) => site.file === file).length + 1,
      `${file}: the import and the calls: the function is never stored, passed or wrapped by another name`);
  }
  // The trace store has one call, in its private method, for all nine kinds of change.
  assert.deepEqual(sites.filter((site) => site.file === TRACE_STORE).map((site) => site.owner), ["log"]);
  // No other file of src names the function: not the critical event stream, the recording, the capture lifecycle
  // coordinator or any library the Hook hands a callback to.
  const naming: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(ts|tsx)$/.test(entry.name) && readFileSync(file, "utf8").includes("logDiagnostic")) naming.push(file.split(path.sep).join("/"));
    }
  };
  walk("src");
  assert.deepEqual(naming.sort(), [HOOK, "src/lib/meeting/diagnostic-log.ts", TRACE_STORE]);
});

const ancestors = (node: ts.Node) => { const chain: ts.Node[] = []; for (let current = node.parent; current; current = current.parent) chain.push(current); return chain; };
function collect<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return found;
}
const named = (name: string) => (node: ts.Node): node is ts.Identifier => ts.isIdentifier(node) && node.text === name;

test("LG3 the two additive facts are read-only: the selection reason of a stage result is read for the trace key, the observation entry and the stage selections alone, and the Type boolean for its entry alone; the trace store names neither", () => {
  // Every read of the reason of a Relation stage result in the Hook is the value of a `...SelectionReason` trace key, is
  // inside the observation summary, or is the stage settle's one write of the stage selections (its condition and its
  // value). (Two other objects of the Hook have a field of the same name; they are not stage results.)
  const reasonReads = collect(hook, (node): node is ts.PropertyAccessExpression => ts.isPropertyAccessExpression(node) &&
    node.name.text === "selectionReason" && /(^|\.)result$/.test(node.expression.getText(hook)));
  assert.deepEqual(reasonReads.map((read) => {
    const chain = ancestors(read);
    const key = chain.find(ts.isPropertyAssignment);
    if (key && key.initializer === read && /SelectionReason[`\]]*$/.test(key.name.getText(hook))) return "trace key";
    if (chain.some((node) => ts.isVariableDeclaration(node) && node.name.getText(hook) === "logObservationStageSettled")) return "observation entry";
    const write = chain.find(ts.isIfStatement);
    return write && write.expression.getText(hook) === "result?.selectionReason" && ts.isBlock(write.thenStatement) &&
      write.thenStatement.statements.length === 1 && /^stageSelections(\.canonical|\[[^\]]+\]) = \{/.test(write.thenStatement.statements[0]!.getText(hook))
      ? "stage selection write" : "other";
  }).sort(), ["observation entry", "observation entry", "stage selection write", "stage selection write", "stage selection write",
    "stage selection write", "trace key", "trace key"]);
  // The three additive trace keys are written and never read: nothing in the Hook reads them back from a trace.
  assert.deepEqual(collect(hook, (node): node is ts.PropertyAccessExpression => ts.isPropertyAccessExpression(node) &&
    /^taskRelation(ChildAffinity|ParentAffinity|SplitCanonical)SelectionReason$/.test(node.name.text)), []);
  // No branch of the selector's neighbours selects, waits or retries on the reason: these modules do not name it.
  for (const file of ["src/lib/meeting/task-relation-split-shadow.ts", "src/lib/meeting/ordered-settlement-coordinator.ts",
    "src/lib/meeting/session-recording.ts"]) {
    assert.equal(/selectionReason|SelectionReason"/.test(readFileSync(file, "utf8").replace(/sourceOwnedSetupSelectionReason/g, "")), false, file);
  }
  // The one boolean local of the Voice wait-timer branch: declared once, and read only as an argument of its log call.
  const pending = collect(hook, named("typeOutcomePendingAtDeadline"));
  assert.equal(pending.filter((node) => ts.isVariableDeclaration(node.parent) && node.parent.name === node).length, 1);
  const reads = pending.filter((node) => !(ts.isVariableDeclaration(node.parent) && node.parent.name === node));
  assert.equal(reads.length, 2, "the level and the entry's own field");
  for (const read of reads) {
    assert.ok(ancestors(read).some((node) => ts.isCallExpression(node) && node.expression.getText(hook) === "logDiagnostic"),
      "read inside the logger call");
  }
  // The trace store, which logs each of its changes since commit 3, names neither fact: it counts the keys of a
  // metadata patch and reads none of them.
  const traceStore = readFileSync(TRACE_STORE, "utf8");
  const storeClass = traceStore.slice(traceStore.indexOf("export class MeetingTraceStore"), traceStore.indexOf("export interface MeetingTraceValueSummary"));
  assert.ok(storeClass.includes("logDiagnostic(") && storeClass.includes("countMetadataKeys(metadata)"));
  assert.equal(/selectionReason|SelectionReason|typeOutcomePendingAtDeadline/.test(storeClass), false);
});

test("LG3 the stage selections are a diagnostics-only carrier: one optional field of the handle type, one object per scheduled operation, written by the two stage settles and read by the formal summary alone; no decision, selection, wait or recorded value reads it", () => {
  const ORDERED = "src/lib/meeting/ordered-relation-operation.ts";
  // In src, the Ordered operation's module and the Hook name the field, and nothing else does.
  const naming: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(ts|tsx)$/.test(entry.name) && readFileSync(file, "utf8").includes("stageSelections")) naming.push(file.split(path.sep).join("/"));
    }
  };
  walk("src");
  assert.deepEqual(naming.sort(), [HOOK, ORDERED]);

  // The Ordered operation's module declares it, optional, on the handle type. That is its one mention there, and the
  // selection reason is named nowhere else in that module: the operation that decides the relation never reads either.
  const orderedText = readFileSync(ORDERED, "utf8");
  const ordered = ts.createSourceFile("ordered.ts", orderedText, ts.ScriptTarget.Latest, true);
  const declared = collect(ordered, named("stageSelections"));
  assert.equal(declared.length, 1, "one mention in the Ordered operation's module");
  const signature = declared[0]!.parent;
  assert.ok(ts.isPropertySignature(signature) && signature.questionToken, "an optional property of a type");
  assert.ok(ts.isInterfaceDeclaration(signature.parent) && signature.parent.name.text === "TaskRelationAdjudicationScheduleHandle");
  for (const mention of collect(ordered, named("selectionReason"))) assert.ok(ancestors(mention).includes(signature), "the reason is named in that signature alone");
  assert.equal(orderedText.split("TaskRelationCandidateSelectionReason").length - 1, 2, "the reason type: its import and that signature");

  // The Hook: every mention of the name, by what it is.
  const binding = hookDeclaration("resolveOrderedTaskRelationWithinWindow");
  const schedule = hookDeclaration("scheduleTaskRelationSplitRuntime");
  const assemble = hookDeclaration("scheduleTaskRelationAdjudication");
  const kinds = collect(hook, named("stageSelections")).map((mention) => {
    const parent = mention.parent, chain = ancestors(mention);
    if (ts.isPropertySignature(parent)) return "split handle type";
    if (chain.includes(binding)) return "summary";
    if (ts.isVariableDeclaration(parent) && parent.name === mention && chain.includes(schedule)) return "per-operation object";
    if (ts.isShorthandPropertyAssignment(parent) && chain.includes(schedule) && chain.some(ts.isReturnStatement)) return "split handle";
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === mention &&
      ts.isBinaryExpression(parent.parent) && parent.parent.left === parent && parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      chain.includes(schedule) && chain.some((node) => ts.isPropertyAssignment(node) && node.name.getText(hook) === "onSettled")) return "stage settle write";
    if (chain.includes(assemble) && (ts.isPropertyAssignment(parent) ||
      (ts.isPropertyAccessExpression(parent) && parent.name === mention && parent.expression.getText(hook) === "formalSplitHandle"))) return "product handle";
    return `other: ${parent.getText(hook).slice(0, 80)}`;
  });
  assert.deepEqual(kinds.filter((kind) => kind !== "summary").sort(), ["per-operation object", "product handle", "product handle",
    "split handle", "split handle type", "stage settle write", "stage settle write"]);
  assert.ok(kinds.includes("summary"));
  // One object per scheduled operation: a constant of the schedule callback's own body, initialised empty. It is not a
  // ref, a module value or anything two operations could share.
  const object = collect(schedule, (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && node.name.getText(hook) === "stageSelections")[0]!;
  const scheduleCallback = (schedule.initializer as ts.CallExpression).arguments[0] as ts.ArrowFunction;
  assert.equal(object.parent.parent.parent, scheduleCallback.body, "declared in the body of the schedule callback");
  assert.equal(object.initializer!.getText(hook), "{}");
  // Only a formal operation lends it to the product handle, like every other model field.
  assert.equal(collect(assemble, (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && node.name.getText(hook) === "stageSelections")
    .map((property) => property.initializer.getText(hook)).join(), "formalSplitHandle?.stageSelections");

  // The summary: the binding's metadata write hands the trace store exactly what the Ordered operation gave it, reads
  // the field from the handle once, and everything derived from it ends in the one logger call. It reads no trace.
  const record = collect(binding, (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && node.name.getText(hook) === "recordMetadata");
  assert.equal(record.length, 1);
  const body = (record[0]!.initializer as ts.ArrowFunction).body as ts.Block;
  assert.equal(body.statements[0]!.getText(hook), "traceStoreRef.current.updateMetadata(traceId, metadata);");
  const handleReads = collect(body, (node): node is ts.PropertyAccessExpression => ts.isPropertyAccessExpression(node) && node.name.text === "stageSelections");
  assert.deepEqual(handleReads.map((read) => [read.getText(hook), ts.isVariableDeclaration(read.parent) && read.parent.name.getText(hook)]),
    [["input.handle.stageSelections", "stageSelections"]]);
  const logCalls = collect(body, (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(hook) === "logDiagnostic");
  assert.equal(logCalls.length, 1);
  const locals = collect(body, (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name));
  const derived = new Set(["stageSelections"]);
  for (let grew = true; grew;) {
    grew = false;
    for (const local of locals) {
      const name = (local.name as ts.Identifier).text;
      if (!derived.has(name) && local.initializer && collect(local.initializer, (node): node is ts.Identifier => ts.isIdentifier(node) && derived.has(node.text)).length) {
        derived.add(name); grew = true;
      }
    }
  }
  assert.deepEqual([...derived].sort(), ["lostModelEvidence", "stageLost", "stageSelections"]);
  for (const use of collect(body, (node): node is ts.Identifier => ts.isIdentifier(node) && derived.has(node.text))) {
    if (ts.isVariableDeclaration(use.parent) && use.parent.name === use) continue;
    if (ts.isPropertyAccessExpression(use.parent) && use.parent.name === use) continue;
    const chain = ancestors(use);
    assert.ok(chain.includes(logCalls[0]!) || chain.some((node) => ts.isVariableDeclaration(node) && node.initializer !== undefined &&
      derived.has(node.name.getText(hook)) && (use.pos >= node.initializer.pos && use.end <= node.initializer.end)),
    `${use.text} at ${hook.getLineAndCharacterOfPosition(use.getStart(hook)).line + 1} is read for the logger call alone`);
  }
  assert.equal(collect(body, ts.isReturnStatement).filter((statement) => !ancestors(statement).includes(logCalls[0]!) &&
    !ancestors(statement).some((node) => ts.isVariableDeclaration(node) && node.name.getText(hook) === "stageLost")).length, 0,
  "the metadata write returns nothing to the Ordered operation");
  assert.equal(/getTraces?\(/.test(binding.getText(hook)), false, "nothing is read back from the trace");
  // The summary makes no dispatch claim.
  assert.equal(/requestTerminalSeen|ProviderOutcomeStatus/.test(binding.getText(hook)), false);
});

test("LG the not-graded list names each case once and says what the log holds for it", () => {
  assert.equal(new Set(DIAGNOSTIC_LOG_NOT_GRADED.map((row) => row.id)).size, DIAGNOSTIC_LOG_NOT_GRADED.length);
  for (const row of DIAGNOSTIC_LOG_NOT_GRADED) assert.ok(["debug", "none"].includes(row.entry) && row.what.length > 0, row.id);
  // The cases A5 and A6 leave ungraded are on it.
  for (const id of ["relation-mixed", "relation-runtime-budget-refused", "screen-answer", "other-operation-timeouts", "advisor-total-elapsed-observation"]) {
    assert.ok(DIAGNOSTIC_LOG_NOT_GRADED.some((row) => row.id === id), id);
  }
  // Known limits are stated on the rows they belong to.
  const limits = Object.fromEntries(DIAGNOSTIC_LOG_LEDGER.filter((row) => row.knownLimits).map((row) => [`${row.source} ${row.event}`, row.knownLimits!.length]));
  // Seventeen source-reviewed catches retain bounded text; two evaluation catches use fixed codes.
  // The two queued-segment catches carry no cause (the migration test proves the actual boundaries).
  const causeLimits = Object.fromEntries(DIAGNOSTIC_LOG_LEDGER.filter((row) => row.knownLimits?.includes(CAUSE_LIMIT)).map((row) => [`${row.source} ${row.event}`, 1]));
  const noCause = Object.fromEntries(DIAGNOSTIC_LOG_LEDGER.filter((row) => row.knownLimits?.includes(NO_CAUSE_ON_PROVIDER_PATH)).map((row) => [`${row.source} ${row.event}`, 1]));
  assert.deepEqual([Object.keys(causeLimits).length, Object.keys(noCause).sort()], [17, ["meeting.audio-queue microphone-segment-failed", "meeting.audio-queue system-segment-failed"]]);
  assert.deepEqual(DIAGNOSTIC_LOG_LEDGER.filter(row => row.caught?.safeCode).map(row => `${row.source} ${row.event}`).sort(),
    ["meeting.evaluation observed-projection-persist-failed", "meeting.evaluation persistence-failed"]);
  assert.deepEqual(limits, { "meeting.relation formal-operation-settled": 2, "meeting.question-type foreground-deadline-finalized": 1,
    "meeting.trace store-event": 2, "meeting.native-audio lifecycle-event": 1, "meeting.raw-zero-input probe-observed": 4,
    "meeting.manual-action type-correction-recorded": 1, ...causeLimits, ...noCause,
    "meeting.evaluation observed-projection-persist-failed": 1, "meeting.evaluation persistence-failed": 1,
    // A second limit of their own: the retry that a changed payload supersedes, the refresh that repeats, and the step of the close.
    "meeting.trace-metrics persist-failed": 2, "meeting.stt-evaluation-capture refresh-failed": 2, "meeting.recording close-failed": 2 });
  assert.match(CAUSE_LIMIT, /cut at 160 UTF-16 code units/);
  assert.match(CAUSE_LIMIT, /can name a path or a device/);
  // Decisions A8, item 6: the M2 row states that a scheduled retry is not a retry that ran.
  assert.match(DIAGNOSTIC_LOG_LEDGER.find((row) => row.event === "persist-failed")!.knownLimits![1]!,
    /A scheduled retry that a changed payload supersedes leaves that payload unsaved with a debug entry only/);
  // Decisions A8, item 2: the probe report says what the default level holds of the run log Task 145 asks for, and what it does not.
  assert.match(DIAGNOSTIC_LOG_LEDGER.find((row) => row.event === "probe-observed")!.knownLimits![0]!, /at the default level Info the run log holds the four action stages/);
  assert.match(DIAGNOSTIC_LOG_LEDGER.find((row) => row.event === "probe-observed")!.knownLimits![0]!, /Task 145/);
  assert.match(DIAGNOSTIC_LOG_LEDGER.find((row) => row.event === "probe-observed")!.knownLimits![0]!, /a warning that no probe action follows has no entry there/);
  assert.match(DIAGNOSTIC_LOG_LEDGER.find((row) => row.event === "foreground-deadline-finalized")!.knownLimits![0]!, /no longer active/);
});

// A cause as a native command gives one: a path with a space, an operating system error. Within the cut.
const SAMPLE_CAUSE = "Error: failed to write /Users/example/Library/Application Support/jarvis/meeting-trace-metrics.json: No space left on device (os error 28)";
assert.ok(SAMPLE_CAUSE.length <= CAUSE_CHARS);

test("LG4 ledger rows are deliverable as they are listed: every key and every listed value passes the real logger unchanged, with nothing refused or cut", () => {
  for (const row of DIAGNOSTIC_LOG_LEDGER) {
    assert.ok(Object.keys(row.data).length <= leaf.DIAGNOSTIC_LOG_LIMITS.dataKeys, `${row.event}: at most 16 data keys`);
    // One entry per listed value of the widest field, so every listed value is sent once.
    const widest = Math.max(1, ...Object.values(row.data).map((kind) => (Array.isArray(kind) ? kind.length : 1)));
    for (const level of row.levels) for (let pick = 0; pick < widest; pick += 1) {
      const spy = createDiagnosticLogSpy({ threshold: "trace", now: () => 1 });
      const data = Object.fromEntries(Object.entries(row.data).map(([name, kind]) => [name,
        kind === "boolean" ? pick % 2 === 0 : kind === "count" ? pick : kind === "ms" ? 4000 + pick
          : kind === "code" ? "affinity-below-release-threshold" : kind === "identifier" ? "capture_3f2b1c9e-7a44-4c1d-9b1e-2f6a8d0c5e71"
            : kind === "label" ? "Fact anchor output authorization" : kind === "bounded-text" ? SAMPLE_CAUSE : kind[pick % kind.length]!]));
      const refs = Object.fromEntries(row.refs.map((name) => [name, `${name}_1759570000000_ab12cd`]));
      spy.logDiagnostic(level, row.source, row.event, () => ({ refs, data }));
      const label = `${row.source} ${row.event} ${level} #${pick}`;
      // A site with no reference or no field sends an entry without that part.
      assert.deepEqual(spy.entries(), [{ v: 1, at: 1, level, source: row.source, event: row.event,
        ...(row.refs.length ? { refs } : {}), ...(Object.keys(data).length ? { data } : {}) }], label);
      const counters = spy.snapshot();
      assert.deepEqual([counters.refusedEntries, counters.refusedFields, counters.truncatedFields, counters.oversizeEntries,
        counters.detailFailures, counters.internalErrors], [0, 0, 0, 0, 0, 0], label);
      assertEntryInLedger(spy.entries()[0]!, label);
    }
  }
});

test("LG4 the ledger check itself refuses what a call site must not send: a message, an unlisted key, a value outside the list, a sentence as an identifier", () => {
  const base = { v: 1 as const, at: 1, level: "warn" as const, source: "meeting.fact-risk-review", event: "review-ended" };
  assertEntryInLedger({ ...base, data: { stage: "settled", status: "failed", cause: "deadline-exceeded" } });
  for (const [name, entry] of [
    ["a message", { ...base, message: "the provider said no" }],
    ["an unlisted data key", { ...base, data: { stage: "settled", reason: "anything" } }],
    ["a value outside the list", { ...base, data: { stage: "settled", cause: PLANTED_VALUES[0]! } }],
    ["a level the site never uses", { ...base, level: "error" as const }],
    ["an unlisted reference", { ...base, refs: { operationId: "fact-risk:1" } }],
    ["a sentence as an identifier", { ...base, refs: { traceId: "a trace id with spaces" } }],
    ["a count that is not a whole number", { ...base, data: { flagCount: 1.5 } }],
  ] as const) {
    assert.throws(() => assertEntryInLedger(entry as leaf.DiagnosticLogEntry), assert.AssertionError, name);
  }
  assert.throws(() => assertNothingPlanted([{ ...base, data: { cause: PLANTED_VALUES[1]!.slice(0, 20) } }], PLANTED_VALUES, "self-check"),
    assert.AssertionError, "a cut planted text is still found");
});

test("LG1 the spy runs the real leaf: its own instance, the same exports and limits, the threshold before the detail, and delivery in order through the one command", () => {
  const spy = createDiagnosticLogSpy({ now: () => 42 });
  assert.deepEqual(Object.keys(spy.logger).sort(), Object.keys(leaf).sort());
  assert.deepEqual(spy.logger.DIAGNOSTIC_LOG_LIMITS, leaf.DIAGNOSTIC_LOG_LIMITS);
  assert.notEqual(spy.logger.logDiagnostic, leaf.logDiagnostic, "an instance of its own");
  assert.equal(spy.snapshot().threshold, "info", "the default threshold");
  for (const threshold of DIAGNOSTIC_LOG_SPY_LEVELS) {
    const own = createDiagnosticLogSpy({ threshold, now: () => 42 });
    let built = 0;
    for (const level of DIAGNOSTIC_LOG_SPY_LEVELS) own.logDiagnostic(level, "meeting.relation", "formal-operation-settled", () => { built += 1; return { data: { waitMs: 1 } }; });
    const passes = DIAGNOSTIC_LOG_SPY_LEVELS.slice(0, DIAGNOSTIC_LOG_SPY_LEVELS.indexOf(threshold) + 1);
    assert.deepEqual(own.entries().map((entry) => entry.level), passes, threshold);
    assert.equal(built, passes.length, `${threshold}: a filtered call never builds its detail`);
    assert.deepEqual([own.snapshot().filtered, own.snapshot().accepted], [5 - passes.length, passes.length], threshold);
    assert.ok(own.calls.every((call) => call.command === "write_diagnostic_log" && call.level === threshold), threshold);
    assert.equal(own.pendingTimers(), 0, "no timer of the logger is left");
    // The console mirror of an accepted entry is collected, not printed.
    assert.deepEqual(own.mirrored.map((line) => line.entry.level), passes, threshold);
  }
});

test("LG5 the spy's failing deliveries are the logger's own failure paths: the entries are handed over, counted as not delivered, and each failure is counted where the leaf counts it", () => {
  const counted = { reject: "ipcFailures", never: "ipcTimeouts", malformed: "ipcMalformedReceipts" } as const;
  assert.deepEqual(DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES, ["reject", "never", "malformed", "throw"]);
  for (const delivery of DIAGNOSTIC_LOG_SPY_FAILING_DELIVERIES) {
    const spy = createDiagnosticLogSpy({ threshold: "trace", now: () => 7, delivery });
    spy.logDiagnostic("warn", "meeting.relation", "formal-operation-settled", () => ({ data: { waitMs: 1 } }));
    spy.logDiagnostic("debug", "meeting.relation", "formal-operation-settled", () => ({ data: { waitMs: 2 } }));
    // What crossed the boundary is what a working delivery is handed.
    assert.deepEqual(spy.entries().map((entry) => [entry.level, entry.data]), [["warn", { waitMs: 1 }], ["debug", { waitMs: 2 }]], delivery);
    const counters = spy.snapshot();
    assert.deepEqual([counters.accepted, counters.undeliveredEntries, counters.native.accepted, counters.internalErrors, counters.queued,
      counters.inFlight, spy.pendingTimers()], [2, 2, 0, 0, 0, false, 0], delivery);
    assert.equal(counters.ipcFailures + counters.ipcTimeouts + counters.ipcMalformedReceipts, counters.ipcCalls, delivery);
    // A throwing invoke entry is a rejected call; drained here before its rejection is read, it ends at the reply timeout.
    if (delivery !== "throw") assert.equal(counters[counted[delivery]], counters.ipcCalls, delivery);
  }
});

// ---- the loss counters the Hook hands to the panel ----

function hookDeclaration(name: string): ts.VariableDeclaration {
  const found: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(hook) === name) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(hook);
  assert.equal(found.length, 1, `exactly one declaration of ${name}`);
  return found[0]!;
}
const transpile = (code: string) => ts.transpileModule(`(${code})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
// The Hook's two statements, evaluated in order with the logger instance of a spy.
function readLoss(logger: typeof leaf) {
  const context = vm.createContext({ readDiagnosticLogSnapshot: logger.readDiagnosticLogSnapshot }) as Record<string, unknown>;
  context.diagnosticLogCounters = vm.runInContext(transpile(hookDeclaration("diagnosticLogCounters").initializer!.getText(hook)), context);
  return JSON.parse(JSON.stringify(vm.runInContext(transpile(hookDeclaration("diagnosticLogLoss").initializer!.getText(hook)), context))) as Record<string, number>;
}
const NO_LOSS = { frontendShed: 0, frontendRefusedEntries: 0, frontendDetailLeftOut: 0, frontendInternalErrors: 0, frontendUndelivered: 0,
  nativeRejected: 0, nativeDropped: 0, nativeWriteFailures: 0 };

test("LG5 loss counters: the Hook reads what the frontend logger shed, refused and could not deliver and what native refused, dropped and failed to write, from the logger's own counters", async () => {
  // Nothing lost: every count is zero, before and after ordinary entries.
  const quiet = createDiagnosticLogSpy({ threshold: "trace" });
  assert.deepEqual(readLoss(quiet.logger), NO_LOSS);
  quiet.logDiagnostic("warn", "meeting.relation", "formal-operation-settled", () => ({ data: { waitMs: 1 } }));
  quiet.logDiagnostic("trace", "meeting.relation", "formal-operation-settled");
  quiet.entries();
  assert.deepEqual(readLoss(quiet.logger), NO_LOSS, "delivered entries and filtered calls are not a loss");

  // Refused: an entry refused whole, and a detail part left out of an accepted one.
  const refusing = createDiagnosticLogSpy({ threshold: "trace" });
  refusing.logDiagnostic("warn", "Not A Tag", "formal-operation-settled");
  refusing.logDiagnostic("warn", "meeting.relation", "formal-operation-settled", () => ({ data: { nested: { a: 1 } as never, waitMs: 2 } }));
  assert.deepEqual(refusing.entries().map((entry) => entry.data), [{ waitMs: 2 }]);
  assert.deepEqual(readLoss(refusing.logger), { ...NO_LOSS, frontendRefusedEntries: 1, frontendDetailLeftOut: 1 });

  // A detail function that throws: the entry is sent with no detail at all, and that is counted as detail left out.
  const throwing = createDiagnosticLogSpy({ threshold: "trace" });
  throwing.logDiagnostic("warn", "meeting.relation", "formal-operation-settled", () => { throw new Error("detail"); });
  assert.deepEqual(throwing.entries().map((entry) => [entry.level, entry.refs, entry.data]), [["warn", undefined, undefined]]);
  assert.deepEqual([throwing.snapshot().detailFailures, readLoss(throwing.logger)], [1, { ...NO_LOSS, frontendDetailLeftOut: 1 }]);

  // An entry over the size limit is sent without its detail, marked: counted as detail left out as well.
  const oversize = createDiagnosticLogSpy({ threshold: "trace" });
  oversize.logDiagnostic("warn", "meeting.relation", "formal-operation-settled", () => ({
    data: Object.fromEntries(Array.from({ length: 16 }, (_unused, index) => [`field${index}`, "plain words ".repeat(20)])) }));
  assert.deepEqual(oversize.entries().map((entry) => Object.keys(entry.data ?? {})), [["oversizeBytes"]]);
  assert.deepEqual([oversize.snapshot().oversizeEntries, oversize.snapshot().refusedFields, readLoss(oversize.logger)],
    [1, 0, { ...NO_LOSS, frontendDetailLeftOut: 1 }]);

  // An entry call made from inside a detail function is refused whole; the outer entry is sent.
  const reentrant = createDiagnosticLogSpy({ threshold: "trace" });
  reentrant.logDiagnostic("warn", "meeting.relation", "formal-operation-settled", () => {
    reentrant.logDiagnostic("error", "meeting.advisor", "request-ended");
    return { data: { waitMs: 3 } };
  });
  assert.deepEqual(reentrant.entries().map((entry) => [entry.event, entry.data]), [["formal-operation-settled", { waitMs: 3 }]]);
  assert.deepEqual([reentrant.snapshot().reentrantCalls, readLoss(reentrant.logger)], [1, { ...NO_LOSS, frontendRefusedEntries: 1 }]);

  // What the line does not count, stated: a string cut to its limit is sent cut and is not a loss here.
  const cutting = createDiagnosticLogSpy({ threshold: "trace" });
  cutting.logDiagnostic("warn", "meeting.relation", "formal-operation-settled", () => ({ data: { reason: "plain words ".repeat(40) } }));
  assert.deepEqual([cutting.entries().length, cutting.snapshot().truncatedFields, readLoss(cutting.logger)], [1, 1, NO_LOSS]);

  // Shed, undelivered and the native sink's totals need a boundary that can be full, fail and report: the real
  // module instance with the native side of the Tauri boundary controlled, as in tests/diagnostic-log.test.ts.
  const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const run = async () => {
    for (let round = 0; round < 200 && timers.size > 0; round += 1) {
      const [id, callback] = timers.entries().next().value as [number, () => void];
      timers.delete(id); callback();
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    }
  };
  let reply: (args: { level: string; entries: unknown[] }) => unknown = () => Promise.reject("the sink directory is not writable");
  (globalThis as any).setTimeout = (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; };
  (globalThis as any).clearTimeout = (id: number) => { timers.delete(id); };
  (globalThis as any).window = { __TAURI_INTERNALS__: { invoke: (_command: string, args: { level: string; entries: unknown[] }) => reply(args) } };
  const consoleMethods = ["error", "warn", "info", "debug"] as const;
  const realConsole = consoleMethods.map((method) => console[method]);
  for (const method of consoleMethods) console[method] = () => {};
  try {
    const logger = (await import(new URL("../src/lib/meeting/diagnostic-log.js?loss=1", import.meta.url).href)) as typeof leaf;
    logger.setDiagnosticLogThreshold("trace");
    // A rejected call: its three entries are counted as not delivered.
    for (let index = 0; index < 3; index += 1) logger.logDiagnostic("warn", "meeting.relation", "formal-operation-settled");
    await run();
    assert.deepEqual(readLoss(logger), { ...NO_LOSS, frontendUndelivered: 3 });
    // A call that never answers: once its reply timeout has run, its entry is counted as not delivered too.
    reply = () => new Promise(() => {});
    logger.logDiagnostic("error", "meeting.advisor", "request-ended");
    await run();
    assert.deepEqual(readLoss(logger), { ...NO_LOSS, frontendUndelivered: 4 });
    // A queue that is not flushed fills at 512 entries; what comes after is shed.
    for (let index = 0; index < leaf.DIAGNOSTIC_LOG_LIMITS.queueEntries + 5; index += 1) logger.logDiagnostic("debug", "meeting.relation", "formal-operation-settled");
    assert.deepEqual(readLoss(logger), { ...NO_LOSS, frontendUndelivered: 4, frontendShed: 5 });
    // The native sink's own totals arrive with a receipt: the latest one is what is shown.
    const reporting = (await import(new URL("../src/lib/meeting/diagnostic-log.js?loss=2", import.meta.url).href)) as typeof leaf;
    reply = (args) => Promise.resolve({ v: 1, appliedLevel: args.level, accepted: args.entries.length, filtered: 0, rejected: 0, dropped: 0,
      sink: { state: "degraded", droppedTotal: 7, writeFailures: 2, unsavedAtExit: 0 } });
    reporting.logDiagnostic("warn", "meeting.relation", "formal-operation-settled");
    await run();
    assert.deepEqual(readLoss(reporting), { ...NO_LOSS, nativeDropped: 7, nativeWriteFailures: 2 });
    // A failure of the logger itself, here its console mirror: counted as an internal error, and the entry is still sent.
    const failing = (await import(new URL("../src/lib/meeting/diagnostic-log.js?loss=3", import.meta.url).href)) as typeof leaf;
    let received = 0;
    reply = (args) => { received += args.entries.length; return Promise.resolve({ v: 1, appliedLevel: args.level, accepted: args.entries.length,
      filtered: 0, rejected: 0, dropped: 0, sink: { state: "ready", droppedTotal: 0, writeFailures: 0, unsavedAtExit: 0 } }); };
    console.warn = () => { throw new Error("console"); };
    failing.logDiagnostic("warn", "meeting.relation", "formal-operation-settled");
    await run();
    assert.deepEqual([received, failing.readDiagnosticLogSnapshot().internalErrors, readLoss(failing)],
      [1, 1, { ...NO_LOSS, frontendInternalErrors: 1 }]);
    // Entries native refused as malformed or over a bound: each receipt says how many of its call, and the count shown is
    // what the receipts of this page reported so far. A later receipt that refuses nothing leaves it as it is.
    // What the line does not count, stated: what the sink had not saved at exit, which is known only at exit.
    const rejecting = (await import(new URL("../src/lib/meeting/diagnostic-log.js?loss=4", import.meta.url).href)) as typeof leaf;
    console.warn = () => {};
    reply = (args) => Promise.resolve({ v: 1, appliedLevel: args.level, accepted: 0, filtered: 0, rejected: args.entries.length, dropped: 0,
      sink: { state: "ready", droppedTotal: 0, writeFailures: 0, unsavedAtExit: 4 } });
    rejecting.logDiagnostic("warn", "meeting.relation", "formal-operation-settled");
    await run();
    assert.deepEqual([rejecting.readDiagnosticLogSnapshot().native.rejected, rejecting.readDiagnosticLogSnapshot().native.sink?.unsavedAtExit,
      readLoss(rejecting)], [1, 4, { ...NO_LOSS, nativeRejected: 1 }]);
    rejecting.logDiagnostic("warn", "meeting.relation", "formal-operation-settled");
    rejecting.logDiagnostic("warn", "meeting.relation", "formal-operation-settled");
    await run();
    assert.deepEqual(readLoss(rejecting), { ...NO_LOSS, nativeRejected: 3 });
    reply = (args) => Promise.resolve({ v: 1, appliedLevel: args.level, accepted: args.entries.length, filtered: 0, rejected: 0, dropped: 0,
      sink: { state: "ready", droppedTotal: 0, writeFailures: 0, unsavedAtExit: 0 } });
    rejecting.logDiagnostic("warn", "meeting.relation", "formal-operation-settled");
    await run();
    assert.deepEqual([rejecting.readDiagnosticLogSnapshot().native.accepted, readLoss(rejecting)], [1, { ...NO_LOSS, nativeRejected: 3 }]);
    assert.equal("unsavedAtExit" in readLoss(rejecting) || /unsavedAtExit/.test(hookDeclaration("diagnosticLogLoss").initializer!.getText(hook)), false,
      "what was not saved at exit is not projected");
  } finally {
    globalThis.setTimeout = realTimeout; globalThis.clearTimeout = realClear;
    delete (globalThis as any).window;
    consoleMethods.forEach((method, index) => { console[method] = realConsole[index]!; });
  }
});

test("LG5 loss counters are read when the Hook renders and by nothing else: no effect, timer, state or request reads them", () => {
  const counters = hookDeclaration("diagnosticLogCounters"), loss = hookDeclaration("diagnosticLogLoss");
  assert.equal(counters.initializer!.getText(hook), "readDiagnosticLogSnapshot()");
  // Both are statements of the Hook's own body: evaluated on every render, inside no callback, effect or memo.
  const hookFunction = hook.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "useMeetingAssistant")!;
  for (const declaration of [counters, loss]) assert.equal(declaration.parent.parent.parent, hookFunction.body);
  const readers = (name: string) => {
    const found: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === name) {
        let current: ts.Node = node;
        while (current.parent && current.parent !== hookFunction.body) current = current.parent;
        found.push(ts.isReturnStatement(current) ? "return" : ts.isVariableStatement(current)
          ? current.declarationList.declarations[0]!.name.getText(hook) : ts.SyntaxKind[current.kind]);
      }
      ts.forEachChild(node, visit);
    };
    visit(hookFunction);
    return [...new Set(found)];
  };
  assert.deepEqual(readers("diagnosticLogCounters"), ["diagnosticLogCounters", "diagnosticLogLoss"]);
  assert.deepEqual(readers("diagnosticLogLoss"), ["diagnosticLogLoss", "return"]);
  const snapshotCalls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(hook) === "readDiagnosticLogSnapshot") snapshotCalls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(hook);
  assert.equal(snapshotCalls.length, 1, "one read of the counters in the Hook");
  assert.doesNotMatch(loss.initializer!.getText(hook), /setInterval|setTimeout|useEffect|useState|invoke\(/);
});
