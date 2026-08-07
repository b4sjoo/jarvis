import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeRuntimeCommit,
  createRuntimeCommitToken,
} from "../src/lib/meeting/runtime-commit-authorization.js";
import { ScreenOperationCoordinator } from "../src/lib/meeting/screen-operation-coordinator.js";

const SNAPSHOT = {
  runtimeEpoch: 3,
  sessionId: "session-a",
};

test("a newer screen operation supersedes the active operation and trace", () => {
  const coordinator = new ScreenOperationCoordinator();

  assert.deepEqual(coordinator.claim("screen-a", 100), {
    operationId: "screen-a",
    requestedAt: 100,
    supersedesOperationId: undefined,
    supersedesTraceId: undefined,
  });
  assert.equal(coordinator.attachTrace("screen-a", "trace-a"), true);

  assert.deepEqual(coordinator.claim("screen-b", 200), {
    operationId: "screen-b",
    requestedAt: 200,
    supersedesOperationId: "screen-a",
    supersedesTraceId: "trace-a",
  });
  assert.equal(coordinator.owns("screen-a"), false);
  assert.equal(coordinator.release("screen-a"), false);
  assert.equal(coordinator.getActiveOperationId(), "screen-b");
});

test("only the latest screen operation owns runtime commit authority", () => {
  const coordinator = new ScreenOperationCoordinator();
  coordinator.claim("screen-a", 100);
  const firstToken = createRuntimeCommitToken({
    operationId: "screen-a",
    pipeline: "screen",
    snapshot: SNAPSHOT,
  });

  coordinator.claim("screen-b", 200);
  const secondToken = createRuntimeCommitToken({
    operationId: "screen-b",
    pipeline: "screen",
    snapshot: SNAPSHOT,
  });

  assert.equal(
    authorizeRuntimeCommit({
      token: firstToken,
      current: SNAPSHOT,
      currentOperationId: coordinator.getActiveOperationId(),
    }).reason,
    "pipeline-owner-mismatch"
  );
  assert.equal(
    authorizeRuntimeCommit({
      token: secondToken,
      current: SNAPSHOT,
      currentOperationId: coordinator.getActiveOperationId(),
    }).reason,
    "authorized"
  );
});

test("a stale release cannot clear the latest screen operation", () => {
  const coordinator = new ScreenOperationCoordinator();
  coordinator.claim("screen-a", 100);
  coordinator.claim("screen-b", 200);

  assert.equal(coordinator.release("screen-a"), false);
  assert.equal(coordinator.getActiveOperationId(), "screen-b");
  assert.equal(coordinator.release("screen-b"), true);
  assert.equal(coordinator.getActiveOperationId(), null);
});
