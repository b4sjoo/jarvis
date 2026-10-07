import assert from 'node:assert/strict';
import test from 'node:test';
import { browserBundle, openProjectSelectionBrowserHost, playwright, browserTestSkip, fixtures }
  from './project-selection-hook-browser.test.mjs';

const question = "I think that's the solution a bit. I think I can follow your resume. You also mentioned one thing about platform engineering automation, and this is like you engineered an automation pipeline. Can you describe a little bit more for what this pipeline contains, like what the role of each component, how each component works?";
const memory = [...fixtures.S63_MEMORY, ...Array.from({ length: 7 }, (_, i) => ({
  ...fixtures.S63_MEMORY[0], id: `pg154-other-${i}`, projectId: `other-${i}`, projectName: `Other Project ${i}`,
  title: `Other Project ${i} evidence`, content: `I implemented an unrelated component for Other Project ${i}.`,
}))];

test('PG154 final PDD owns project discovery and fact review despite a resume opening hint', {
  timeout: 180000, skip: browserTestSkip,
}, async t => {
  const bundle = await browserBundle();
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE });
  try {
    for (const [source, surface, mode, empty] of [
      ['voice', 'normal', 'shadow', false], ['voice', 'focus', 'enforcement', false],
      ['screen', 'focus', 'shadow', false], ['voice', 'normal', 'shadow', true],
    ]) await t.test(`${source}/${surface}/${mode}/empty=${empty}`, async child => {
      const { page, context, failures } = await openProjectSelectionBrowserHost(child, bundle, browser,
        { source, surface }, { mountOnly: true, question, memory: empty ? [] : memory, guardrailMode: mode,
          answers: { ...fixtures.S63_PROVIDER_ANSWERS,
            initial: 'Answer: I implemented the pipeline with a 40% improvement.\nApproach: Original reasoning.' } });
      try {
        assert.equal(await page.evaluate(() => window.__s63.meeting.startRuntimeRegressionRun()), true);
        if (source === 'voice') assert.equal(await page.evaluate(text => window.__s63.meeting.submitRuntimeRegressionText(text), question), true);
        else await page.evaluate(() => window.__s63.meeting.captureScreenContext());
        await page.waitForFunction(() => Boolean(window.__s63.observed.adviseDisplay.stable), undefined, { timeout: 8000 });
        await page.waitForFunction(() => window.__s63.meeting.traces.some(trace =>
          trace.id === window.__s63.observed.adviseDisplay.stable.suggestion.sourceTraceId), undefined, { timeout: 3000 });
        const observed = await page.evaluate(() => {
          const stable = window.__s63.observed.adviseDisplay.stable;
          const trace = window.__s63.meeting.traces.find(t => t.id === stable.suggestion.sourceTraceId);
          return { metadata: trace.metadata, parent: window.__s63.meeting.taskRuntime.parent,
            reviewInput: stable.suggestion.factRiskReviewInput,
            pending: stable.suggestion.projectIdentityPending, content: stable.suggestion.content };
        });
        assert.equal(observed.metadata.settledExecutionPlanQuestionType, 'project-deep-dive');
        assert.equal(observed.parent.stableKind, 'project-deep-dive');
        assert.equal(observed.metadata.projectBindingAction, 'needs-selection');
        assert.equal(observed.metadata.projectBindingCandidateCount, empty ? 0 : 9);
        assert.equal(observed.metadata.factAnchorRequiredFor, 'project-deep-dive');
        assert.ok(observed.reviewInput);
        assert.equal(observed.pending, true);
        assert.match(observed.content, /40%/, 'Reviewer cannot rewrite the answer');
        await page.waitForFunction(() => window.__s63.meeting.traces.some(t => t.metadata?.factRiskReview?.status === 'completed'), undefined, { timeout: 6000 });
        assert.equal(await page.evaluate(() => window.__s63.requests.filter(r => r.factRiskReview).length), 1);
        if (mode === 'shadow') assert.equal(await page.locator('[data-fact-risk-review]').count(), 0);
        else await page.getByText('Measurement needs verification.', { exact: true }).waitFor();
        if (!empty) {
          await page.evaluate(() => { window.__s63.stage = 'selected'; });
          await page.getByRole('button', { name: 'Quartz Relay', exact: true }).click();
          await page.waitForFunction(() => window.__s63.observed.selection?.status === 'succeeded', undefined, { timeout: 6000 });
          const after = await page.evaluate(() => ({
            parent: window.__s63.meeting.taskRuntime.parent,
            answer: window.__s63.observed.adviseDisplay.sections.primaryAnswer,
            selectedRequests: window.__s63.requests.filter(r => r.selectedFactPromptChecked).length,
          }));
          assert.equal(after.parent.id, observed.parent.id);
          assert.equal(after.parent.projectBinding.projectId, 'quartz_relay');
          assert.equal(after.parent.projectBinding.revision, 1);
          assert.equal(after.selectedRequests, 1);
          assert.match(after.answer, /partition-key routing/);
        }
        await page.evaluate(() => window.__s63.meeting.stopRuntimeRegressionRun());
        assert.deepEqual(failures, []);
        assert.deepEqual(await page.evaluate(() => window.__s63.unexpected), []);
      } finally { await context.close(); }
    });
  } finally { await browser.close(); }
});
