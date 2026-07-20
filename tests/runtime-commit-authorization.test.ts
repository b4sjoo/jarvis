import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeRuntimeCommit,
  createRuntimeCommitToken,
  formatRuntimeCommitAuthorizationForTrace,
  rebaseRuntimeCommitToken,
  type RuntimeCommitSnapshot,
} from "../src/lib/meeting/runtime-commit-authorization.js";

const BASE_SNAPSHOT: RuntimeCommitSnapshot = {
  runtimeEpoch: 3,
  sessionId: "meeting-a",
  parentId: "parent-a",
  parentRevision: 4,
};

test("authorizes an exact current runtime and pipeline owner", () => {
  const token = createRuntimeCommitToken({
    operationId: "advisor-a",
    pipeline: "advisor",
    snapshot: BASE_SNAPSHOT,
  });

  assert.deepEqual(
    authorizeRuntimeCommit({
      token,
      current: BASE_SNAPSHOT,
      currentOperationId: "advisor-a",
    }).reason,
    "authorized"
  );
});

test("rejects epoch before session and parent mismatches", () => {
  const token = createRuntimeCommitToken({
    operationId: "screen-a",
    pipeline: "screen",
    snapshot: BASE_SNAPSHOT,
  });
  const decision = authorizeRuntimeCommit({
    token,
    current: {
      runtimeEpoch: 4,
      sessionId: "meeting-b",
      parentId: "parent-b",
      parentRevision: 1,
    },
    currentOperationId: "screen-b",
  });

  assert.equal(decision.authorized, false);
  assert.equal(decision.reason, "runtime-epoch-mismatch");
});

test("rejects session, parent presence, id, revision, and owner independently", () => {
  const token = createRuntimeCommitToken({
    operationId: "correction-a",
    pipeline: "correction",
    snapshot: BASE_SNAPSHOT,
  });
  const decide = (
    current: RuntimeCommitSnapshot,
    currentOperationId: string | null = "correction-a"
  ) => authorizeRuntimeCommit({ token, current, currentOperationId }).reason;

  assert.equal(
    decide({ ...BASE_SNAPSHOT, sessionId: "meeting-b" }),
    "session-mismatch"
  );
  assert.equal(
    decide({
      runtimeEpoch: 3,
      sessionId: "meeting-a",
    }),
    "parent-presence-mismatch"
  );
  assert.equal(
    decide({ ...BASE_SNAPSHOT, parentId: "parent-b" }),
    "parent-id-mismatch"
  );
  assert.equal(
    decide({ ...BASE_SNAPSHOT, parentRevision: 5 }),
    "parent-revision-mismatch"
  );
  assert.equal(decide(BASE_SNAPSHOT, "correction-b"), "pipeline-owner-mismatch");
  assert.equal(decide(BASE_SNAPSHOT, null), "pipeline-owner-mismatch");
  assert.equal(
    authorizeRuntimeCommit({
      token,
      current: BASE_SNAPSHOT,
      currentOperationId: undefined,
    }).reason,
    "pipeline-owner-mismatch"
  );
});

test("an absent-parent token rejects a parent created while work is pending", () => {
  const token = createRuntimeCommitToken({
    operationId: "screen-a",
    pipeline: "screen",
    snapshot: {
      runtimeEpoch: 1,
      sessionId: "meeting-a",
    },
  });

  assert.equal(token.parentExpectation.kind, "absent");
  assert.equal(
    authorizeRuntimeCommit({
      token,
      current: {
        runtimeEpoch: 1,
        sessionId: "meeting-a",
        parentId: "parent-created-later",
        parentRevision: 1,
      },
      currentOperationId: "screen-a",
    }).reason,
    "parent-presence-mismatch"
  );
});

test("session-only tokens ignore parent changes but still enforce epoch and owner", () => {
  const token = createRuntimeCommitToken({
    operationId: "correction-lifecycle-a",
    pipeline: "correction",
    snapshot: BASE_SNAPSHOT,
    parentPolicy: "session-only",
  });

  assert.equal(
    authorizeRuntimeCommit({
      token,
      current: {
        ...BASE_SNAPSHOT,
        parentId: "parent-b",
        parentRevision: 9,
      },
      currentOperationId: "correction-lifecycle-a",
    }).reason,
    "authorized"
  );
  assert.equal(
    authorizeRuntimeCommit({
      token,
      current: { ...BASE_SNAPSHOT, runtimeEpoch: 4 },
      currentOperationId: "correction-lifecycle-a",
    }).reason,
    "runtime-epoch-mismatch"
  );
});

test("formats reconstructable authorization telemetry", () => {
  const token = createRuntimeCommitToken({
    operationId: "memory-a",
    pipeline: "memory",
    snapshot: BASE_SNAPSHOT,
  });
  const decision = authorizeRuntimeCommit({
    token,
    current: { ...BASE_SNAPSHOT, parentRevision: 5 },
    currentOperationId: "memory-a",
  });

  assert.deepEqual(
    formatRuntimeCommitAuthorizationForTrace(decision, "post-memory"),
    {
      runtimeOperationId: "memory-a",
      runtimePipeline: "memory",
      runtimeAuthorizationStage: "post-memory",
      runtimeExpectedEpoch: 3,
      runtimeCurrentEpoch: 3,
      runtimeExpectedSessionId: "meeting-a",
      runtimeCurrentSessionId: "meeting-a",
      runtimeParentExpectation: "exact",
      runtimeExpectedParentId: "parent-a",
      runtimeExpectedParentRevision: 4,
      runtimeCurrentParentId: "parent-a",
      runtimeCurrentParentRevision: 5,
      runtimeCommitAuthorized: false,
      runtimeCommitAuthorizationReason: "parent-revision-mismatch",
    }
  );
});

test("rebases one operation onto the committed parent revision", () => {
  const original = createRuntimeCommitToken({
    operationId: "advisor-next",
    pipeline: "advisor",
    snapshot: BASE_SNAPSHOT,
  });
  const committedPhaseSnapshot = {
    ...BASE_SNAPSHOT,
    parentRevision: 8,
  };
  const rebased = rebaseRuntimeCommitToken({
    token: original,
    snapshot: committedPhaseSnapshot,
  });

  assert.equal(rebased.operationId, original.operationId);
  assert.equal(rebased.pipeline, original.pipeline);
  assert.deepEqual(rebased.parentExpectation, {
    kind: "exact",
    parentId: "parent-a",
    parentRevision: 8,
  });
  assert.equal(
    authorizeRuntimeCommit({
      token: rebased,
      current: committedPhaseSnapshot,
      currentOperationId: "advisor-next",
    }).reason,
    "authorized"
  );
});
