import assert from "node:assert/strict";
import test from "node:test";
import {
  composePrimaryAskProjection,
  isPrimaryAskCompletion,
  projectPrimaryAsk,
  reconcilePrimaryAskTurnDecision,
} from "../src/lib/meeting/primary-ask-projection.js";
import { decideAdvisorTurnIntent } from "../src/lib/meeting/advisor-turn-intent.js";

test("selects the terminal current ask after recruiter setup and quoted examples", () => {
  const text =
    "When you meet the team, you can ask what are your biggest challenges? You can also ask what does the scope look like? With that, how does this sound relative to what you're looking for?";
  const result = projectPrimaryAsk({ turnId: "turn_dense", text });

  assert.equal(result.disposition, "answer-primary-ask");
  assert.equal(
    result.normalizedPrimaryAsk,
    "how does this sound relative to what you're looking for?"
  );
  assert.equal(result.quotedOrFutureExampleSpans.length, 2);
  assert.equal(result.primaryAskSpans.length, 1);
  assert.equal(
    text.slice(
      result.primaryAskSpans[0]!.start,
      result.primaryAskSpans[0]!.end
    ),
    result.primaryAskSpans[0]!.text
  );
});

test("does not admit future behavioral examples as a current question", () => {
  const text =
    "The next round will include behavioral questions. For example, tell me about a time you disagreed with a manager? You should prepare a few stories.";
  const result = projectPrimaryAsk({ turnId: "turn_future", text });
  const reconciled = reconcilePrimaryAskTurnDecision(
    result,
    decideAdvisorTurnIntent(text, { hasActiveTask: true })
  );

  assert.equal(result.normalizedPrimaryAsk, undefined);
  assert.equal(result.disposition, "append-setup");
  assert.ok(result.quotedOrFutureExampleSpans.length >= 1);
  assert.equal(reconciled.executionAuthorized, false);
  assert.equal(reconciled.action, "append-only");
});

test("composes setup and a later referential direct ask into one projection", () => {
  const setup = projectPrimaryAsk({
    turnId: "turn_setup",
    text:
      "The role focuses on production AI infrastructure, retrieval, and platform reliability.",
  });
  const direct = projectPrimaryAsk({
    turnId: "turn_ask",
    text: "How does this sound relative to what you're looking for?",
  });

  assert.equal(
    isPrimaryAskCompletion({ previous: setup, current: direct }),
    true
  );
  const composed = composePrimaryAskProjection({
    previous: setup,
    current: direct,
    extended: true,
  });

  assert.equal(composed?.disposition, "revise-existing-lqu");
  assert.deepEqual(composed?.sourceTurnIds, ["turn_setup", "turn_ask"]);
  assert.equal(
    composed?.normalizedPrimaryAsk,
    "How does this sound relative to what you're looking for?"
  );
  assert.equal(composed?.setupSpans.length, 1);
});

test("keeps a long direct technical ask on the immediate answer path", () => {
  const result = projectPrimaryAsk({
    turnId: "turn_technical",
    text:
      "Design a ticket selling system that prevents double booking under high concurrency, estimate peak QPS, and explain the consistency tradeoffs.",
  });

  assert.equal(result.disposition, "answer-primary-ask");
  assert.equal(result.speechAct, "directive");
  assert.match(result.normalizedPrimaryAsk ?? "", /ticket selling system/);
  assert.equal(result.quotedOrFutureExampleSpans.length, 0);
});

test("preserves the action-object pair in section-style directives", () => {
  for (const [index, [text, expected]] of [
    ["Maybe let's do ride-sharing backend.", "Maybe let's do ride-sharing backend."],
    ["Let's design a ticket-selling system.", "Let's design a ticket-selling system."],
    ["Now let's implement sliding-window maximum.", "implement sliding-window maximum."],
  ].entries()) {
    const result = projectPrimaryAsk({
      turnId: `turn_action_object_${index}`,
      text,
    });

    assert.equal(result.disposition, "answer-primary-ask", text);
    assert.equal(result.speechAct, "directive", text);
    assert.equal(result.normalizedPrimaryAsk, expected, text);
    assert.equal(result.primaryAskSpans[0]?.text, expected, text);
  }
});

test("does not treat a referential action without a concrete object as standalone", () => {
  const result = projectPrimaryAsk({
    turnId: "turn_referential_action",
    text: "Let's do that.",
  });

  assert.equal(result.normalizedPrimaryAsk, undefined);
  assert.equal(result.disposition, "append-setup");
});

test("treats exact acknowledgement variants as ignorable but keeps an add-on ask", () => {
  const acknowledgement = projectPrimaryAsk({
    turnId: "turn_acknowledgement",
    text: "That looks good to me.",
  });
  assert.equal(acknowledgement.speechAct, "acknowledgement");
  assert.equal(acknowledgement.disposition, "ignore");

  const addOn = projectPrimaryAsk({
    turnId: "turn_acknowledgement_ask",
    text: "That looks good to me, now write merge sort.",
  });
  assert.equal(addOn.disposition, "answer-primary-ask");
  assert.match(addOn.normalizedPrimaryAsk ?? "", /write merge sort/i);
});

test("keeps quoted technical questions append-only when there is no present ask", () => {
  const text =
    "During the next system design round, they may ask how would you shard a ride sharing database?";
  const result = projectPrimaryAsk({ turnId: "turn_quoted", text });

  assert.equal(result.disposition, "append-setup");
  assert.equal(result.normalizedPrimaryAsk, undefined);
  assert.equal(result.quotedOrFutureExampleSpans.length, 1);
});

test("separates recruiter logistics from a genuine candidate-facing question", () => {
  const text =
    "I will send the interview schedule later. Before we finish, do you have any questions for me?";
  const result = projectPrimaryAsk({ turnId: "turn_logistics_ask", text });

  assert.equal(result.disposition, "answer-primary-ask");
  assert.equal(
    result.normalizedPrimaryAsk,
    "do you have any questions for me?"
  );
  assert.deepEqual(
    result.setupSpans.map((span) => span.text),
    ["I will send the interview schedule later.", "Before we finish,"]
  );
});

test("explicit current-question transitions terminate future-example carry", () => {
  const cases = [
    {
      transition: "Now tell me how you built your hardest project.",
      expected: "tell me how you built your hardest project.",
    },
    {
      transition:
        "Let's start with project experience. Tell me about the hardest project you built.",
      expected: "Tell me about the hardest project you built.",
    },
    {
      transition:
        "My question is: tell me about the hardest project you built.",
      expected: "tell me about the hardest project you built.",
    },
    {
      transition:
        "Before we finish, tell me about the hardest project you built.",
      expected: "tell me about the hardest project you built.",
    },
  ];

  for (const [index, current] of cases.entries()) {
    const text = `You can ask what metrics they use. ${current.transition}`;
    const result = projectPrimaryAsk({
      turnId: `turn_current_${index}`,
      text,
    });

    assert.equal(result.disposition, "answer-primary-ask");
    assert.equal(result.normalizedPrimaryAsk, current.expected);
    assert.equal(result.quotedOrFutureExampleSpans.length, 1);
  }

  const sameSentence =
    "A recruiter may ask: how do you handle conflict; now tell me about the hardest project you built.";
  const sameSentenceResult = projectPrimaryAsk({
    turnId: "turn_same_sentence_transition",
    text: sameSentence,
  });

  assert.equal(sameSentenceResult.disposition, "answer-primary-ask");
  assert.equal(
    sameSentenceResult.normalizedPrimaryAsk,
    "tell me about the hardest project you built."
  );
  assert.equal(
    sameSentenceResult.quotedOrFutureExampleSpans[0]?.text,
    "A recruiter may ask: how do you handle conflict;"
  );
  assert.equal(sameSentenceResult.setupSpans[0]?.text, "now");
});

test("preserves exact setup and primary-ask spans within one sentence", () => {
  const text =
    "The role focuses on AI infrastructure, so how does that fit your background?";
  const result = projectPrimaryAsk({ turnId: "turn_same_sentence", text });

  assert.equal(
    result.normalizedPrimaryAsk,
    "how does that fit your background?"
  );
  assert.equal(result.setupSpans.length, 1);
  assert.equal(
    result.setupSpans[0]?.text,
    "The role focuses on AI infrastructure, so"
  );
  assert.deepEqual(
    {
      start: result.setupSpans[0]?.start,
      end: result.setupSpans[0]?.end,
    },
    {
      start: 0,
      end: text.indexOf(" how"),
    }
  );
  for (const span of [...result.setupSpans, ...result.primaryAskSpans]) {
    assert.equal(text.slice(span.start, span.end), span.text);
  }
});

test("preserves exact primary-ask offsets while normalizing classifier text", () => {
  const text =
    "Some setup.  How   does this sound relative to what you are looking for?";
  const result = projectPrimaryAsk({ turnId: "turn_whitespace", text });

  assert.equal(
    result.normalizedPrimaryAsk,
    "How does this sound relative to what you are looking for?"
  );
  assert.equal(
    text.slice(
      result.primaryAskSpans[0]!.start,
      result.primaryAskSpans[0]!.end
    ),
    result.primaryAskSpans[0]!.text
  );
});

test("treats manager and recruiter asks as quoted future examples", () => {
  const subjects = [
    "The manager",
    "Your hiring manager",
    "A recruiter",
    "Our hiring manager",
  ];

  for (const [index, subject] of subjects.entries()) {
    const text = `${subject} may ask: tell me about a time you disagreed with a teammate?`;
    const result = projectPrimaryAsk({
      turnId: `turn_recruiter_example_${index}`,
      text,
    });

    assert.equal(result.normalizedPrimaryAsk, undefined);
    assert.equal(result.disposition, "append-setup");
    assert.equal(result.quotedOrFutureExampleSpans.length, 1);
  }
});
