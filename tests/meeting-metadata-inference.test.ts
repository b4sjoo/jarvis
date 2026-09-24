import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import {
  authorizeMeetingMetadataInferenceLease,
  buildMeetingMetadataInferencePrompts,
  buildMeetingMetadataInferenceRequest,
  compareMeetingMetadataInference,
  createMeetingMetadataInferenceLease,
  decideMeetingMetadataInferenceCommit,
  decideMeetingMetadataInferenceEligibility,
  formatMeetingMetadataInferenceForTrace,
  parseMeetingMetadataInferenceOutput,
  projectMeetingMetadataOpeningEvidence,
} from "../src/lib/meeting/meeting-metadata-inference.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import type {
  InterviewTargetCompany,
  TranscriptTurn,
} from "../src/lib/meeting/types.js";

function turn(
  id: string,
  text: string,
  speaker: "me" | "them" = "them",
  startedAt = 1_000
): TranscriptTurn {
  return {
    id,
    text,
    speaker,
    startedAt,
    endedAt: startedAt + 500,
    isFinal: true,
    source: speaker === "them" ? "system-audio" : "microphone",
  };
}

function requestFrom(turns: TranscriptTurn[], company?: InterviewTargetCompany) {
  const evidence = projectMeetingMetadataOpeningEvidence({
    transcriptTurns: turns,
    sessionStartedAt: 500,
  });
  return buildMeetingMetadataInferenceRequest({
    sessionId: "session-a",
    evidence,
    authoritativeCompany: company,
  });
}

test("projects only bounded interviewer opening evidence", () => {
  const turns = [
    turn("me-1", "I am the candidate.", "me"),
    ...Array.from({ length: 8 }, (_, index) =>
      turn(
        `them-${index + 1}`,
        `${index + 1}: ${"x".repeat(700)}`,
        "them",
        1_000 + index * 1_000
      )
    ),
    turn("late", "I am from Late Company.", "them", 700_000),
  ];
  const evidence = projectMeetingMetadataOpeningEvidence({
    transcriptTurns: turns,
    sessionStartedAt: 500,
  });

  assert.equal(evidence.turns.length, 3);
  assert.equal(evidence.turns.every((item) => item.text.length <= 600), true);
  assert.equal(evidence.totalChars, 1_800);
  assert.equal(evidence.omittedTurnCount, 5);
  assert.equal(
    decideMeetingMetadataInferenceEligibility({
      currentTurnId: "them-1",
      evidence,
    }).eligible,
    true
  );
  assert.equal(
    decideMeetingMetadataInferenceEligibility({
      currentTurnId: "them-4",
      evidence,
    }).reason,
    "outside-bounded-opening-window"
  );
});

test("builds an atomic company-only prompt", () => {
  const request = requestFrom([
    turn(
      "them-1",
      "I am the recruiter from Oracle. Your AWS work is relevant to this role."
    ),
  ]);
  const prompts = buildMeetingMetadataInferencePrompts(request);

  assert.match(prompts.systemPrompt, /which organization/i);
  assert.match(prompts.systemPrompt, /candidate's former employer/i);
  assert.match(prompts.systemPrompt, /HackerRank/);
  assert.match(prompts.systemPrompt, /coding or interview platforms/i);
  assert.doesNotMatch(prompts.systemPrompt, /questionType/);
  assert.match(prompts.userMessage, /Oracle/);
  assert.match(prompts.userMessage, /AWS/);
});

test("strictly parses grounded company and abstention proposals", () => {
  const request = requestFrom([
    turn(
      "them-1",
      "I am the recruiter from Oracle, based in Taiwan."
    ),
  ]);
  const parsed = parseMeetingMetadataInferenceOutput(
    JSON.stringify({
      schemaVersion: 1,
      company: "Oracle",
      confidence: 0.98,
      evidenceSpans: ["the recruiter from Oracle"],
      abstainReason: null,
    }),
    request
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.company, "Oracle");

  const abstained = parseMeetingMetadataInferenceOutput(
    JSON.stringify({
      schemaVersion: 1,
      company: null,
      confidence: 0.2,
      evidenceSpans: [],
      abstainReason: "Only a vendor location is named.",
    }),
    request
  );
  assert.equal(abstained.ok, true);
  if (abstained.ok) assert.equal(abstained.value.company, null);
});

test("rejects invented evidence and cross-operation fields", () => {
  const request = requestFrom([
    turn("them-1", "I am the recruiter from Oracle."),
  ]);
  const invented = parseMeetingMetadataInferenceOutput(
    JSON.stringify({
      schemaVersion: 1,
      company: "Oracle",
      confidence: 0.99,
      evidenceSpans: ["Oracle is conducting the interview"],
      abstainReason: null,
    }),
    request
  );
  assert.equal(invented.ok, false);
  if (!invented.ok) assert.equal(invented.reason, "invalid-evidence-span");

  const broad = parseMeetingMetadataInferenceOutput(
    JSON.stringify({
      schemaVersion: 1,
      company: "Oracle",
      confidence: 0.99,
      evidenceSpans: ["recruiter from Oracle"],
      abstainReason: null,
      questionType: "project-deep-dive",
    }),
    request
  );
  assert.equal(broad.ok, false);
  if (!broad.ok) assert.equal(broad.reason, "non-metadata-field-present");
});

test("requires a company proposal to appear in its grounded evidence", () => {
  const request = requestFrom([
    turn(
      "them-1",
      "We will use HackerRank for the coding exercise. Welcome to today's interview."
    ),
  ]);
  const ungroundedCompany = parseMeetingMetadataInferenceOutput(
    JSON.stringify({
      schemaVersion: 1,
      company: "HackerRank",
      confidence: 0.99,
      evidenceSpans: ["Welcome to today's interview"],
      abstainReason: null,
    }),
    request
  );
  assert.equal(ungroundedCompany.ok, false);
  if (!ungroundedCompany.ok) {
    assert.equal(
      ungroundedCompany.reason,
      "company-not-grounded-in-evidence"
    );
  }

  const aliasRequest = requestFrom([
    turn("them-1", "I am the recruiter from AWS."),
  ]);
  const canonicalAlias = parseMeetingMetadataInferenceOutput(
    JSON.stringify({
      schemaVersion: 1,
      company: "Amazon",
      confidence: 0.98,
      evidenceSpans: ["recruiter from AWS"],
      abstainReason: null,
    }),
    aliasRequest
  );
  assert.equal(canonicalAlias.ok, true);
});

test("lease rejects newer evidence, epochs, and authoritative company changes", () => {
  const authoritative: InterviewTargetCompany = {
    value: "Oracle",
    normalized: "oracle",
    confidence: 1,
    source: "brief",
    evidence: "Preparation Snapshot",
    updatedAt: 1_000,
  };
  const request = requestFrom(
    [turn("them-1", "I am the recruiter from Oracle.")],
    authoritative
  );
  const lease = createMeetingMetadataInferenceLease({
    sessionId: "session-a",
    runtimeEpoch: 3,
    mode: "shadow",
    request,
    createdAt: 2_000,
  });
  const current = {
    currentOperationId: lease.operationId,
    sessionId: "session-a",
    runtimeEpoch: 3,
    evidence: request.openingEvidence,
    authoritativeCompany: authoritative,
    mode: "shadow" as const,
  };
  assert.deepEqual(authorizeMeetingMetadataInferenceLease(lease, current), {
    authorized: true,
  });
  assert.equal(
    authorizeMeetingMetadataInferenceLease(lease, {
      ...current,
      runtimeEpoch: 4,
    }).authorized,
    false
  );
  assert.equal(
    authorizeMeetingMetadataInferenceLease(lease, {
      ...current,
      authoritativeCompany: { ...authoritative, value: "Google" },
    }).authorized,
    false
  );
  assert.equal(
    authorizeMeetingMetadataInferenceLease(lease, {
      ...current,
      mode: "enforcement",
    }).authorized,
    false
  );
});

test("lease owns bounded evidence and company snapshots independently of request mutation", () => {
  const company: InterviewTargetCompany = {
    value: "Oracle",
    normalized: "oracle",
    confidence: 1,
    source: "brief",
    evidence: "Preparation Snapshot",
    updatedAt: 1_000,
  };
  const request = requestFrom(
    [turn("them-1", "I am the recruiter from Oracle.")],
    company
  );
  const evidence = structuredClone(request.openingEvidence);
  const lease = createMeetingMetadataInferenceLease({
    sessionId: request.sessionId,
    runtimeEpoch: 3,
    mode: "shadow",
    request,
  });
  request.openingEvidence.turns[0].text = "Changed after dispatch";
  request.authoritativeCompany!.value = "Changed after dispatch";

  assert.equal(lease.openingEvidenceTurns[0].text, evidence.turns[0].text);
  assert.equal(lease.authoritativeCompany?.value, company.value);
  assert.deepEqual(
    authorizeMeetingMetadataInferenceLease(lease, {
      currentOperationId: lease.operationId,
      sessionId: request.sessionId,
      runtimeEpoch: 3,
      evidence,
      authoritativeCompany: company,
      mode: "shadow",
    }),
    { authorized: true }
  );
});

test("lease compares every selected opening turn field in order", () => {
  const turns = [
    turn("them-1", "Welcome to the interview.", "them", 1_000),
    turn("them-2", "We are hiring for this role.", "them", 2_000),
  ];
  const request = requestFrom(turns);
  const lease = createMeetingMetadataInferenceLease({
    sessionId: request.sessionId,
    runtimeEpoch: 3,
    mode: "enforcement",
    request,
  });
  const changedTurns = [
    [...turns].reverse(),
    [{ ...turns[0], id: "them-other" }, turns[1]],
    [{ ...turns[0], text: "Welcome to another interview." }, turns[1]],
    [{ ...turns[0], startedAt: 1_001 }, turns[1]],
    [{ ...turns[0], endedAt: 1_501 }, turns[1]],
  ];
  for (const transcriptTurns of changedTurns) {
    const evidence = projectMeetingMetadataOpeningEvidence({
      transcriptTurns,
      sessionStartedAt: 500,
    });
    assert.equal(evidence.turns.length, request.openingEvidence.turns.length);
    assert.deepEqual(
      authorizeMeetingMetadataInferenceLease(lease, {
        currentOperationId: lease.operationId,
        sessionId: request.sessionId,
        runtimeEpoch: 3,
        evidence,
        mode: "enforcement",
      }),
      { authorized: false, reason: "source-hash-mismatch" }
    );
  }

  const windowTurns = Array.from({ length: 7 }, (_, index) =>
    turn(`window-${index}`, `Opening turn ${index}.`, "them", 1_000 + index * 1_000)
  );
  const windowRequest = requestFrom(windowTurns);
  const windowLease = createMeetingMetadataInferenceLease({
    sessionId: windowRequest.sessionId,
    runtimeEpoch: 3,
    mode: "enforcement",
    request: windowRequest,
  });
  const shiftedWindow = projectMeetingMetadataOpeningEvidence({
    transcriptTurns: [
      { ...windowTurns[0], startedAt: 700_000 },
      ...windowTurns.slice(1),
    ],
    sessionStartedAt: 500,
  });
  assert.equal(shiftedWindow.turns.length, windowRequest.openingEvidence.turns.length);
  assert.deepEqual(
    authorizeMeetingMetadataInferenceLease(windowLease, {
      currentOperationId: windowLease.operationId,
      sessionId: windowRequest.sessionId,
      runtimeEpoch: 3,
      evidence: shiftedWindow,
      mode: "enforcement",
    }),
    { authorized: false, reason: "source-hash-mismatch" }
  );
});

test("lease distinguishes opening evidence hidden by the old delimiter hash", () => {
  const first = requestFrom([turn("a\u001fb", "c")]);
  const alias = requestFrom([turn("a", "b\u001fc")]);
  assert.equal(first.openingEvidence.sourceHash, alias.openingEvidence.sourceHash);
  const lease = createMeetingMetadataInferenceLease({
    sessionId: first.sessionId,
    runtimeEpoch: 3,
    mode: "shadow",
    request: first,
  });
  assert.equal(
    lease.operationId,
    createMeetingMetadataInferenceLease({
      sessionId: alias.sessionId,
      runtimeEpoch: 3,
      mode: "shadow",
      request: alias,
    }).operationId
  );
  assert.deepEqual(
    authorizeMeetingMetadataInferenceLease(lease, {
      currentOperationId: lease.operationId,
      sessionId: first.sessionId,
      runtimeEpoch: 3,
      evidence: alias.openingEvidence,
      mode: "shadow",
    }),
    { authorized: false, reason: "source-hash-mismatch" }
  );
});

test("lease compares authoritative company presence, value, normalization, and source", () => {
  const company: InterviewTargetCompany = {
    value: "Oracle",
    normalized: "oracle",
    confidence: 1,
    source: "brief",
    evidence: "Preparation Snapshot",
    updatedAt: 1_000,
  };
  const request = requestFrom([turn("them-1", "Oracle interview")], company);
  const lease = createMeetingMetadataInferenceLease({
    sessionId: request.sessionId,
    runtimeEpoch: 3,
    mode: "enforcement",
    request,
  });
  const base = {
    currentOperationId: lease.operationId,
    sessionId: request.sessionId,
    runtimeEpoch: 3,
    evidence: request.openingEvidence,
    mode: "enforcement" as const,
  };
  for (const authoritativeCompany of [
    undefined,
    { ...company, value: "Amazon" },
    { ...company, normalized: "amazon" },
    { ...company, source: "manual" as const },
  ]) {
    assert.deepEqual(
      authorizeMeetingMetadataInferenceLease(lease, {
        ...base,
        authoritativeCompany,
      }),
      { authorized: false, reason: "authoritative-company-changed" }
    );
  }
  assert.deepEqual(
    authorizeMeetingMetadataInferenceLease(lease, {
      ...base,
      authoritativeCompany: { ...company, confidence: 0.8, updatedAt: 2_000 },
    }),
    { authorized: true }
  );

  const noCompany = requestFrom([turn("them-1", "Oracle interview")]);
  const noCompanyLease = createMeetingMetadataInferenceLease({
    sessionId: noCompany.sessionId,
    runtimeEpoch: 3,
    mode: "enforcement",
    request: noCompany,
  });
  assert.deepEqual(
    authorizeMeetingMetadataInferenceLease(noCompanyLease, {
      ...base,
      currentOperationId: noCompanyLease.operationId,
      authoritativeCompany: company,
    }),
    { authorized: false, reason: "authoritative-company-changed" }
  );
});

test("lease rejects company delimiter alias while retaining operation identity", () => {
  const company: InterviewTargetCompany = {
    value: "a\u001fb",
    normalized: "c",
    confidence: 1,
    source: "brief",
    evidence: "Preparation Snapshot",
    updatedAt: 1_000,
  };
  const alias: InterviewTargetCompany = {
    ...company,
    value: "a",
    normalized: "b\u001fc",
  };
  const request = requestFrom([turn("them-1", "Welcome to the interview")], company);
  const aliasRequest = requestFrom([turn("them-1", "Welcome to the interview")], alias);
  const lease = createMeetingMetadataInferenceLease({
    sessionId: request.sessionId,
    runtimeEpoch: 3,
    mode: "shadow",
    request,
  });
  assert.equal(
    lease.operationId,
    createMeetingMetadataInferenceLease({
      sessionId: aliasRequest.sessionId,
      runtimeEpoch: 3,
      mode: "shadow",
      request: aliasRequest,
    }).operationId
  );
  assert.deepEqual(
    authorizeMeetingMetadataInferenceLease(lease, {
      currentOperationId: lease.operationId,
      sessionId: request.sessionId,
      runtimeEpoch: 3,
      evidence: request.openingEvidence,
      authoritativeCompany: alias,
      mode: "shadow",
    }),
    { authorized: false, reason: "authoritative-company-changed" }
  );
});

test("formats the latest authoritative company instead of the scheduled request snapshot", () => {
  const request = requestFrom([
    turn("them-1", "I am the recruiter from Oracle."),
  ]);
  const latestAuthoritativeCompany: InterviewTargetCompany = {
    value: "Amazon",
    normalized: "amazon",
    confidence: 1,
    source: "brief",
    evidence: "Preparation Snapshot",
    updatedAt: 2_000,
  };

  const metadata = formatMeetingMetadataInferenceForTrace({
    request,
    authoritativeCompany: latestAuthoritativeCompany,
    disposition: "stale",
    leaseAuthorized: false,
    staleReason: "authoritative-company-changed",
  });

  assert.equal(
    metadata.meetingMetadataInferenceAuthoritativeCompany,
    "Amazon"
  );
  assert.equal(
    metadata.meetingMetadataInferenceAuthoritativeSource,
    "brief"
  );
});

test("compares proposals without granting mutation authority", () => {
  const authoritative: InterviewTargetCompany = {
    value: "Oracle",
    normalized: "oracle",
    confidence: 1,
    source: "brief",
    evidence: "Preparation Snapshot",
    updatedAt: 1_000,
  };
  const proposal = {
    schemaVersion: 1 as const,
    company: "Oracle",
    confidence: 0.98,
    evidenceSpans: ["from Oracle"],
  };
  assert.equal(
    compareMeetingMetadataInference({
      authoritativeCompany: authoritative,
      proposal,
    }).disposition,
    "agreement"
  );
  assert.equal(
    compareMeetingMetadataInference({ proposal }).disposition,
    "unresolved-proposal"
  );
  assert.equal(
    compareMeetingMetadataInference({
      authoritativeCompany: authoritative,
      proposal: { ...proposal, company: "Taiwan" },
    }).disposition,
    "conflict"
  );
});

test("canonicalizes aliases only after a model proposal exists", () => {
  const authoritative: InterviewTargetCompany = {
    value: "Amazon",
    normalized: "amazon",
    confidence: 1,
    source: "brief",
    evidence: "Preparation Snapshot",
    updatedAt: 1_000,
  };
  assert.equal(
    compareMeetingMetadataInference({
      authoritativeCompany: authoritative,
      proposal: {
        schemaVersion: 1,
        company: "AWS",
        confidence: 0.97,
        evidenceSpans: ["from AWS"],
      },
    }).disposition,
    "agreement"
  );
});

test("authorizes only a grounded high-confidence unresolved enforcement proposal", () => {
  const request = requestFrom([
    turn("them-1", "I am the recruiter from AWS."),
  ]);
  const parsed = parseMeetingMetadataInferenceOutput(
    JSON.stringify({
      schemaVersion: 1,
      company: "AWS",
      confidence: 0.98,
      evidenceSpans: ["recruiter from AWS"],
      abstainReason: null,
    }),
    request
  );
  const shadow = decideMeetingMetadataInferenceCommit({
    mode: "shadow",
    leaseAuthorized: true,
    parseResult: parsed,
  });
  assert.deepEqual(shadow, {
    authorized: false,
    reason: "mode-not-enforcement",
  });

  const authorized = decideMeetingMetadataInferenceCommit({
    mode: "enforcement",
    leaseAuthorized: true,
    parseResult: parsed,
  });
  assert.equal(authorized.authorized, true);
  if (authorized.authorized) {
    assert.equal(authorized.targetCompany.value, "Amazon");
    assert.equal(authorized.targetCompany.normalized, "amazon");
  }
});

test("blocks low-confidence, stale, and already resolved proposals", () => {
  const request = requestFrom([
    turn("them-1", "I am the recruiter from Oracle."),
  ]);
  const lowConfidence = parseMeetingMetadataInferenceOutput(
    JSON.stringify({
      schemaVersion: 1,
      company: "Oracle",
      confidence: 0.91,
      evidenceSpans: ["recruiter from Oracle"],
      abstainReason: null,
    }),
    request
  );
  assert.equal(
    decideMeetingMetadataInferenceCommit({
      mode: "enforcement",
      leaseAuthorized: true,
      parseResult: lowConfidence,
    }).reason,
    "confidence-below-threshold"
  );
  assert.equal(
    decideMeetingMetadataInferenceCommit({
      mode: "enforcement",
      leaseAuthorized: false,
      parseResult: lowConfidence,
    }).reason,
    "lease-not-authorized"
  );
  assert.equal(
    decideMeetingMetadataInferenceCommit({
      mode: "enforcement",
      leaseAuthorized: true,
      currentCompany: {
        value: "Google",
        normalized: "google",
        confidence: 1,
        source: "brief",
        evidence: "Preparation Snapshot",
        updatedAt: 2_000,
      },
      parseResult: lowConfidence,
    }).reason,
    "company-already-resolved"
  );
});

test("context manager atomically fills only an unresolved company", () => {
  const manager = new MeetingContextManager();
  const sessionId = manager.getState().sessionId;
  const committed = manager.commitRuntimeInferredTargetCompany({
    expectedSessionId: sessionId,
    targetCompany: {
      value: "Oracle",
      normalized: "oracle",
      confidence: 0.98,
      evidence: "recruiter from Oracle",
    },
    updatedAt: 3_000,
  });
  assert.equal(committed.committed, true);
  assert.equal(
    manager.getState().interviewSessionContext?.targetCompany?.source,
    "runtime-inference"
  );
  assert.deepEqual(
    manager.commitRuntimeInferredTargetCompany({
      expectedSessionId: sessionId,
      targetCompany: {
        value: "Taiwan",
        normalized: "taiwan",
        confidence: 0.99,
        evidence: "based in Taiwan",
      },
    }),
    { committed: false, reason: "company-already-resolved" }
  );

  manager.setInterviewSessionBrief({
    targetCompany: "Google",
    targetCompanyNormalized: "google",
    companyLocked: true,
    interviewTypes: [],
  });
  assert.equal(
    manager.getState().interviewSessionContext?.targetCompany?.value,
    "Google"
  );
  assert.equal(
    manager.getState().interviewSessionContext?.targetCompany?.source,
    "brief"
  );
});

test("production Metadata settlement commits only while its captured evidence and company remain current", () => {
  const source = ts.createSourceFile(
    "hook.ts",
    readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  let scheduler: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "scheduleMeetingMetadataInference"
    ) scheduler = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(scheduler?.initializer);
  const callback = (scheduler.initializer as ts.CallExpression)
    .arguments[0] as ts.ArrowFunction;
  let settled: ts.PropertyAssignment | undefined;
  const findSettled = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "onSettled") {
      settled = node;
    }
    ts.forEachChild(node, findSettled);
  };
  findSettled(callback);
  assert.ok(settled);
  const statements = [
    ...((settled.initializer as ts.ArrowFunction).body as ts.Block).statements,
  ];
  const end = statements.findIndex(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) => declaration.name.getText(source) === "observationDisposition"
      )
  );
  assert.ok(end > 0);
  const block = statements.slice(0, end).map((node) => node.getText(source)).join("\n");

  const run = (change: (manager: MeetingContextManager) => void, initialCompany = false) => {
    const manager = new MeetingContextManager();
    const sessionId = manager.getState().sessionId;
    manager.addTranscriptTurn(turn("them-1", "I am the recruiter from Oracle."));
    if (initialCompany) {
      manager.setInterviewSessionBrief({
        targetCompany: "Google",
        targetCompanyNormalized: "google",
        companyLocked: true,
        interviewTypes: [],
      });
    }
    const scheduled = manager.getState();
    const evidence = projectMeetingMetadataOpeningEvidence({
      transcriptTurns: scheduled.transcriptTurns,
      sessionStartedAt: scheduled.startedAt,
    });
    const request = buildMeetingMetadataInferenceRequest({
      sessionId,
      evidence,
      authoritativeCompany: scheduled.interviewSessionContext?.targetCompany,
    });
    const lease = createMeetingMetadataInferenceLease({
      sessionId,
      runtimeEpoch: 3,
      mode: "enforcement",
      request,
    });
    const parsed = parseMeetingMetadataInferenceOutput(
      JSON.stringify({
        schemaVersion: 1,
        company: "Oracle",
        confidence: 0.98,
        evidenceSpans: ["recruiter from Oracle"],
        abstainReason: null,
      }),
      request
    );
    assert.equal(parsed.ok, true);
    change(manager);
    const env = {
      contextManagerRef: { current: manager },
      projectMeetingMetadataOpeningEvidence,
      authorizeMeetingMetadataInferenceLease,
      meetingMetadataInferenceRuntimeRef: {
        current: { getCurrentOperationId: () => lease.operationId },
      },
      runtimeEpochRef: { current: 3 },
      taxonomyAdjudicationSettingsRef: { current: { meetingMetadataMode: "enforcement" } },
      meetingMetadataInferenceCircuitRef: { current: { open() { throw Error("unexpected provider error"); } } },
      compareMeetingMetadataInference,
      decideMeetingMetadataInferenceCommit,
      setState: (update: (previous: Record<string, unknown>) => unknown) => update({}),
    };
    const code = ts.transpileModule(
      `${block}\nreturn {authorization,commitDecision,commitResult,committed};`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
    ).outputText;
    const result = Function(...Object.keys(env), "settlement", code)(
      ...Object.values(env),
      {
        job: { lease, request },
        result: { parsed, providerDisposition: "completed-with-content" },
        disposition: "completed",
        completedAt: 4_000,
      }
    );
    return { result, company: manager.getState().interviewSessionContext?.targetCompany };
  };

  const current = run(() => {});
  assert.equal(current.result.authorization.authorized, true);
  assert.equal(current.result.committed, true);
  assert.equal(current.company?.value, "Oracle");

  const edited = run((manager) => {
    assert.equal(manager.updateTranscriptTurnText("them-1", "Changed interviewer text."), true);
  });
  assert.deepEqual(edited.result.authorization, {
    authorized: false,
    reason: "source-hash-mismatch",
  });
  assert.equal(edited.result.committed, false);
  assert.equal(edited.company, undefined);

  const clearedBrief = run((manager) => {
    manager.setInterviewSessionBrief(undefined);
  }, true);
  assert.deepEqual(clearedBrief.result.authorization, {
    authorized: false,
    reason: "authoritative-company-changed",
  });
  assert.equal(clearedBrief.result.committed, false);
  assert.equal(clearedBrief.company, undefined);
});
