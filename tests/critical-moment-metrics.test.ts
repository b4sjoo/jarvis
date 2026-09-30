import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionLongitudinalEvaluationReport,
  renderSessionLongitudinalEvaluationMarkdown,
  type LongitudinalCriticalMomentEvaluation,
  type LongitudinalSessionInput,
} from "../scripts/lib/session-longitudinal-evaluation.js";

function session(patch: Partial<LongitudinalCriticalMomentEvaluation> = {}): LongitudinalSessionInput {
  return {
    directory: "/frozen/cmsr",
    manifest: { sessionId: "s" },
    transcriptTurns: [], traceSummaries: [], questionEvaluations: [],
    criticalMomentCandidates: [{
      momentId: "m", sessionId: "s", sourceTurnIds: ["t"], proposedTraceIds: [],
      opportunityEndAt: 100,
    }],
    criticalMomentEvaluations: [{
      momentId: "m", sessionId: "s", sourceTurnIds: ["t"], traceIds: [],
      eligibility: "critical", ...patch,
    }],
  };
}

const labels = [true, false, undefined];
const times = [
  [100, 200], [200, 200], [300, 200],
  [undefined, 200], [100, undefined], [undefined, undefined],
] as const;

for (const useful of labels) for (const trustworthy of labels) for (const naturalStart of labels) {
  for (const [firstUsefulAt, userSpeechStartAt] of times) {
    test(`dual CMSR ${useful}/${trustworthy}/${naturalStart}/${firstUsefulAt}/${userSpeechStartAt}`, () => {
      const input = session({ useful, trustworthy, naturalStart, firstUsefulAt, userSpeechStartAt });
      const frozen = structuredClone(input);
      const result = buildSessionLongitudinalEvaluationReport([input]);
      const out = result.productOutcomes;
      const passes = useful === true && trustworthy === true && naturalStart !== false;
      const comparable = firstUsefulAt !== undefined && userSpeechStartAt !== undefined;
      assert.deepEqual(out.strictWithoutTiming, { numerator: Number(passes), denominator: 1, rate: Number(passes) });
      assert.deepEqual(out.strictWithTiming, {
        numerator: Number(passes && comparable && firstUsefulAt <= userSpeechStartAt),
        denominator: Number(comparable),
        rate: comparable ? Number(passes && firstUsefulAt <= userSpeechStartAt) : null,
      });
      assert.equal(out.guidanceBeforeSpeechCoverage.rate, Number(comparable));
      assert.equal(out.derivationVersion, "task136-cmsr-dual-v1");
      assert.deepEqual(input, frozen);
      const markdown = renderSessionLongitudinalEvaluationMarkdown(result);
      assert.match(markdown, /Strict CMSR without timing:/);
      assert.match(markdown, /Strict CMSR with timing \(comparable subset\):/);
      assert.match(markdown, /conditional on timing coverage/);
      if (!comparable) assert.match(markdown, /Strict CMSR with timing \(comparable subset\): N\/A/);
    });
  }
}

test("non-finite timing, missing reasons, empty denominator and noncritical exclusions", () => {
  for (const value of [NaN, Infinity, -Infinity, undefined]) {
    const out = buildSessionLongitudinalEvaluationReport([session({
      useful: true, trustworthy: true, firstUsefulAt: value, userSpeechStartAt: 200,
    })]).productOutcomes;
    assert.equal(out.strictWithTiming.rate, null);
    assert.equal(out.strictWithoutTiming.rate, 1);
    assert.deepEqual(out.missingTiming, { firstUsefulAtOnly: 1, userSpeechStartAtOnly: 0, both: 0 });
  }
  for (const eligibility of ["not-critical", "uncertain", undefined] as const) {
    const out = buildSessionLongitudinalEvaluationReport([session({ eligibility })]).productOutcomes;
    assert.equal(out.strictWithoutTiming.rate, null);
    assert.equal(out.strictWithTiming.rate, null);
    assert.equal(out.guidanceBeforeSpeechCoverage.rate, null);
  }
  const empty = buildSessionLongitudinalEvaluationReport([]).productOutcomes;
  assert.equal(empty.strictWithTiming.denominator, 0);
});

test("one moment remains one denominator across duplicate candidates, label revisions and regeneration", () => {
  const input = session({ useful: true, trustworthy: true });
  input.criticalMomentCandidates!.push(structuredClone(input.criticalMomentCandidates![0]));
  input.criticalMomentEvaluations!.push({
    ...input.criticalMomentEvaluations![0], traceIds: ["trace", "regen", "trace"],
    firstUsefulAt: 150, userSpeechStartAt: 100, updatedAt: 1000,
  });
  const out = buildSessionLongitudinalEvaluationReport([input]).productOutcomes;
  assert.equal(out.candidateCount, 1);
  assert.equal(out.strictWithoutTiming.rate, 1);
  assert.equal(out.strictWithTiming.rate, 0);
  assert.equal(out.strictWithTiming.denominator, 1);
  assert.equal(out.manyTraceMomentCount, 1);
  assert.equal(out.ttugMs.p50Ms, 50);
});
