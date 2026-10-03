import assert from 'node:assert/strict';
import test from 'node:test';
import {browserBundle, openProjectSelectionBrowserHost, playwright, browserTestSkip, fixtures} from './project-selection-hook-browser.test.mjs';

test('PC1-PC4 real Hook freezes project option authority for Voice and Screen', {timeout:120000, skip:browserTestSkip}, async t => {
  const bundle=await browserBundle();
  const browser=await playwright.chromium.launch({headless:true,executablePath:process.env.JARVIS_CHROMIUM_EXECUTABLE});
  try {
    for(const execution of fixtures.S63_CONSUMER_EXECUTIONS.filter(x=>['S63-N1','S63-F1'].includes(x.executionId))) {
      for(const empty of [true,false]) await t.test(`${execution.executionId} directory-${empty?'empty':'available'}`,async child=>{
        const initial='Answer: Please identify the actual project so I can use its evidence.\nClarifying question: Should I choose a backend project or an ML project?\nClarifying options: Backend | ML';
        const {page,context,failures}=await openProjectSelectionBrowserHost(child,bundle,browser,execution,{
          memory:empty?[]:fixtures.S63_MEMORY,answers:{...fixtures.S63_PROVIDER_ANSWERS,initial},
        });
        try {
          await page.waitForFunction(()=>window.__s63.observed.adviseDisplay.stable?.suggestion.projectIdentityPending===true);
          const before=await page.evaluate(()=>({
            answer:window.__s63.observed.adviseDisplay.sections.primaryAnswer,
            raw:window.__s63.observed.adviseDisplay.sections.clarifyingOptions,
            display:window.__s63.observed.clarifyingOptionDisplay,
            parent:window.__s63.meeting.taskRuntime.parent.id,
            requestCount:window.__s63.requests.length,
            target:window.__s63.observed.adviseDisplay.target,
          }));
          assert.equal(before.answer,'Please identify the actual project so I can use its evidence.');
          assert.equal(before.raw.length,2,'Raw output remains available for quality review');
          assert.deepEqual(before.display.options,[]);
          assert.equal(before.display.showBooleanFallback,false);
          if(execution.surface==='focus') {
            await page.waitForFunction(()=>window.__s63.focusSnapshot?.payload.sections.primaryAnswer.includes('Please identify'));
            const display=await page.evaluate(()=>window.__s63.focusSnapshot.payload);
            assert.deepEqual(display.sections.clarifyingOptions,[]);
            assert.equal(display.showClarifyingBooleanFallback,false);
          }
          const blocked=await page.evaluate(async target=>window.__s63.meeting.answerClarifyingQuestion(
            'Which project?', 'option', {label:'Backend',value:'Backend'}, {displayTarget:target}),before.target);
          assert.equal(blocked.state,'failed');
          assert.equal(blocked.reason,'project-choice-requires-trusted-directory');
          assert.equal(await page.evaluate(()=>window.__s63.requests.length),before.requestCount);
          assert.equal(await page.evaluate(()=>window.__s63.meeting.taskRuntime.parent.id),before.parent);
          if(empty) assert.equal(await page.getByRole('button',{name:'Quartz Relay',exact:true}).count(),0);
          else {
            await page.evaluate(()=>{window.__s63.stage='selected';});
            await page.getByRole('button',{name:'Quartz Relay',exact:true}).click();
            await page.waitForFunction(()=>window.__s63.observed.selection?.status==='succeeded');
            const after=await page.evaluate(()=>({
              bound:window.__s63.meeting.taskRuntime.parent.projectBinding,
              pending:window.__s63.observed.adviseDisplay.stable?.suggestion.projectIdentityPending,
              answer:window.__s63.observed.adviseDisplay.sections.primaryAnswer,
            }));
            assert.equal(after.bound.projectId,'quartz_relay');
            assert.equal(after.bound.revision,1);
            assert.equal(after.pending,false);
            assert.ok(after.answer.includes(fixtures.S63_FACT_B));
            if(execution.source==='voice') {
              const ordinary=await page.evaluate(()=>window.__s63.meeting.answerClarifyingQuestion(
                'Which technical direction?', 'option', {label:'Cedar Analytics',value:'cedar_analytics'},
                {displayTarget:window.__s63.observed.adviseDisplay.target}));
              assert.equal(ordinary.state,'succeeded');
              const stillBound=await page.evaluate(()=>window.__s63.meeting.taskRuntime.parent.projectBinding);
              assert.equal(stillBound.projectId,'quartz_relay');
              assert.equal(stillBound.revision,1,'Even a label matching another real project is ordinary feedback');
            }
          }
          await page.evaluate(()=>window.__s63.meeting.stopRuntimeRegressionRun());
          assert.deepEqual(failures,[]);
          assert.deepEqual(await page.evaluate(()=>window.__s63.unexpected),[]);
        } finally {await context.close();}
      });
    }
  } finally {await browser.close();}
});
