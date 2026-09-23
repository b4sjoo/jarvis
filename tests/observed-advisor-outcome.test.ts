import assert from "node:assert/strict";
import test from "node:test";
import { projectObservedAdvisorAttempt } from "../src/lib/meeting/observed-advisor-outcome.js";

test("projects a visible commit as observed advice", () => {
  const projection = projectObservedAdvisorAttempt({
    advisorExecutionAuthorized: true,
    advisorOutputCommittedToUi: true,
    visibleAnswerRevisionBefore: 4,
    visibleAnswerRevisionAfter: 5,
    generationResultCommitDisposition: "committed",
    generationResultProjectionDisposition: "current-visible",
  });

  assert.equal(projection.runtimeAction, "advise");
  assert.equal(projection.outcome, "visible-committed");
  assert.equal(projection.answerCommitted, true);
});

test("a pinned background commit is complete but not displayed until the real ACK", () => {
  const metadata = {
    advisorStablePublicationCommitted: true,
    advisorOutputCommittedToUi: false,
    publicationHiddenByManualPin: true,
    generationResultCommitDisposition: "committed",
    generationResultProjectionDisposition: "current-visible",
    visibleAnswerRevisionBefore: 4,
    visibleAnswerRevisionAfter: 5,
  };
  const hidden = projectObservedAdvisorAttempt(metadata);
  assert.equal(hidden.answerCommitted, true);
  assert.equal(hidden.outcome, "model-completed");
  assert.equal(hidden.runtimeAction, "advise");
  const displayed = projectObservedAdvisorAttempt({...metadata, advisorOutputAppliedToDisplay:true});
  assert.equal(displayed.outcome, "visible-committed");
});

test("projects current pending delivery as observed advice", () => {
  const projection = projectObservedAdvisorAttempt({
    advisorOutputDisposition: "pending-delivery",
    generationResultCommitDisposition: "pending",
    generationResultProjectionDisposition: "pending",
  });

  assert.equal(projection.runtimeAction, "advise");
  assert.equal(projection.outcome, "delivery-pending");
  assert.equal(projection.answerCommitted, false);
});

test("keeps a formed but publication-rejected candidate as attempted advice", () => {
  const projection = projectObservedAdvisorAttempt({
    generationResultCandidateValidation: "accepted",
    generationResultTerminalCandidateFormed: true,
    generationResultCommitDisposition: "rejected",
    generationResultTerminalDisposition: "rejected",
    advisorOutputDisposition: "publication-rejected",
  });

  assert.equal(projection.runtimeAction, "advise");
  assert.equal(projection.outcome, "model-completed");
  assert.equal(projection.answerCommitted, false);
});

test("projects only a true pre-model suppression as ignore", () => {
  const projection = projectObservedAdvisorAttempt({
    advisorExecutionAuthorized: false,
    advisorJobOutcome: "suppressed",
    turnGateAction: "ignore",
    generationResultTerminalCandidateFormed: false,
  });

  assert.equal(projection.runtimeAction, "ignore");
  assert.equal(projection.outcome, "suppressed");
  assert.equal(projection.modelExecuted, false);
});

test("does not infer an action from authorization or a stale candidate", () => {
  const authorizedOnly = projectObservedAdvisorAttempt({
    advisorExecutionAuthorized: true,
    advisorOutputCommitAuthorized: true,
  });
  const stale = projectObservedAdvisorAttempt({
    generationResultCandidateValidation: "accepted",
    generationResultTerminalCandidateFormed: true,
    generationResultTerminalDisposition: "superseded",
    advisorJobOutcome: "cancelled-by-new-job",
  });

  assert.equal(authorizedOnly.runtimeAction, undefined);
  assert.equal(authorizedOnly.outcome, undefined);
  assert.equal(stale.runtimeAction, undefined);
  assert.equal(stale.outcome, "cancelled-by-new-job");
});

test("projection is read-only over sealed trace metadata", () => {
  const metadata = Object.freeze({
    advisorOutputCommittedToUi: true,
    generationResultCommitDisposition: "committed",
    generationResultVisibleAnswerRevision: 8,
    codeArtifactRevision: 3,
    whiteboardArtifactRevision: 2,
  });
  const before = JSON.stringify(metadata);

  projectObservedAdvisorAttempt(metadata);
  projectObservedAdvisorAttempt(metadata);

  assert.equal(JSON.stringify(metadata), before);
});
