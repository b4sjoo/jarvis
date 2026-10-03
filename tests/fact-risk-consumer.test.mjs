import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,readdirSync} from 'node:fs';
import {browserBundle,openProjectSelectionBrowserHost,playwright,browserTestSkip,fixtures} from './project-selection-hook-browser.test.mjs';

test('RG real publication, visible review, modes and delivery are separate',{timeout:90000,skip:browserTestSkip},async t=>{
  const bundle=await browserBundle();
  const browser=await playwright.chromium.launch({headless:true,executablePath:process.env.JARVIS_CHROMIUM_EXECUTABLE});
  // PC7 (178/168 C3): what each surface displays as the fact-risk result of the same fixture answer.
  const displayedReviews={};
  try {
    for(const [id,mode] of [['S63-N1','enforcement'],['S63-F1','shadow']]) await t.test(id+' '+mode,async child=>{
      const execution=fixtures.S63_CONSUMER_EXECUTIONS.find(x=>x.executionId===id);
      const {page,context,failures}=await openProjectSelectionBrowserHost(child,bundle,browser,execution,{
        memory:[],holdFactReview:true,guardrailMode:mode,
        answers:{...fixtures.S63_PROVIDER_ANSWERS,initial:'Answer: We measured a 40% improvement.\nApproach: Original reasoning.'},
      });
      try {
        await page.waitForFunction(()=>window.__s63.factReviewBlocked===true,undefined,{timeout:6000});
        assert.match(await page.locator('[data-answer]').innerText(),/40%/,'The primary answer is visible before reviewer completion');
        const before=await page.evaluate(()=>({content:window.__s63.observed.adviseDisplay.stable.suggestion.content,
          parent:JSON.stringify(window.__s63.meeting.taskRuntime.parent),target:window.__s63.observed.adviseDisplay.target}));
        await page.evaluate(target=>{for(let i=0;i<4;i++)window.__s63.meeting.recordAdviseDisplayApplied(target,'normal-mode');},before.target);
        assert.equal(await page.evaluate(()=>window.__s63.requests.filter(x=>x.factRiskReview).length),1);
        if(mode==='shadow') assert.equal(await page.locator('[data-fact-risk-review]').count(),0);
        else assert.match(await page.locator('[data-fact-risk-review]').innerText(),/核实中/);
        await page.evaluate(()=>{window.__s63.holdFactReview=false;window.__s63.releaseFactReview();});
        await page.waitForFunction(()=>window.__s63.meeting.traces.some(t=>t.metadata?.factRiskReview?.status==='completed'));
        await page.waitForFunction(()=>Array.from(window.__s63.writes.entries()).some(([file,payload])=>{
          if(!file.startsWith('traces/')||!file.endsWith('.json'))return false;
          try {return JSON.parse(payload).trace?.metadata?.factRiskReview?.status==='completed';}catch{return false;}
        }));
        if(mode==='shadow') {
          assert.equal(await page.locator('[data-fact-risk-review]').count(),0);
          await page.evaluate(()=>window.__s63.meeting.setPersonalEvidenceGuardrailMode('enforcement'));
        }
        await page.getByText('Measurement needs verification.',{exact:true}).waitFor();
        if(process.env.JARVIS_VISUAL_EVIDENCE_DIR) {
          const css=readdirSync('dist/assets').find(file=>file.startsWith('index-')&&file.endsWith('.css'));
          assert.ok(css);
          await page.addStyleTag({content:readFileSync('dist/assets/'+css,'utf8')});
          for(const width of [440,860]) {
            await page.setViewportSize({width,height:700});
            const notice=page.locator('[data-fact-risk-review]');
            assert.equal(await notice.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
            await notice.screenshot({path:process.env.JARVIS_VISUAL_EVIDENCE_DIR+'/'+id+'-'+width+'.png'});
          }
        }
        assert.equal(await page.evaluate(()=>window.__s63.observed.adviseDisplay.stable.suggestion.content),before.content);
        assert.equal(await page.evaluate(()=>JSON.stringify(window.__s63.meeting.taskRuntime.parent)),before.parent);
        // PC7: the notice on this surface is the review of the displayed answer, and Runtime Cross-checks,
        // set through the Hook's exported setter (the one the Preview switch calls), moves neither the
        // review, its single request, the display target, the answer nor the task, and starts no request.
        const readDisplay=()=>page.evaluate(()=>{
          const {observed,meeting,requests,focusSnapshot,surface}=window.__s63,stable=observed.adviseDisplay.stable;
          // As it crosses the Focus wire: absent optional fields are dropped on both sides before comparing.
          const wire=value=>JSON.parse(JSON.stringify(value));
          return {requests:requests.length,factRiskRequests:requests.filter(x=>x.factRiskReview).length,
            review:wire(observed.factRiskReview),target:wire(observed.adviseDisplay.target),
            focusReview:surface==='focus'?wire(focusSnapshot.payload.factRiskReview):null,
            displayedAnswerKey:JSON.stringify([stable.sessionId,stable.runtimeEpoch,stable.taskId,stable.logicalQuestionUnitId,
              stable.logicalQuestionRevision,stable.sections.answer.revision]),
            content:stable.suggestion.content,parent:JSON.stringify(meeting.taskRuntime.parent),
            notice:document.querySelector('[data-fact-risk-review]')?.innerText,
            crossChecks:meeting.settings.runtimeCrossChecksEnabled,
            stored:JSON.parse(localStorage.getItem('meeting_assistant_settings')).runtimeCrossChecksEnabled};
        });
        const display=await readDisplay();
        assert.equal(display.crossChecks,false,'Runtime Cross-checks defaults to off for a store that never held it');
        // Loading writes nothing. In the Shadow run the mode change above already saved the settings, with the default.
        assert.equal(display.stored,mode==='shadow'?false:undefined);
        assert.equal(display.factRiskRequests,1);
        assert.equal(display.review.status,'completed');
        assert.equal(display.review.answerKey,display.displayedAnswerKey,'the review shown is the one of the displayed answer');
        assert.equal(display.target.stableRevision,await page.evaluate(()=>window.__s63.observed.adviseDisplay.stable.revision));
        assert.match(display.notice,/Measurement needs verification\./);
        // This host builds the Focus payload itself, so this proves the real publisher and consumer deliver the review intact.
        // The page's own snapshot composition is executed in tests/preview-controls-ui.test.ts.
        if(execution.surface==='focus') assert.deepEqual(display.focusReview,display.review,'the Focus wire delivers the published review intact');
        else assert.equal(display.focusReview,null);
        displayedReviews[id]={surface:execution.surface,status:display.review.status,flags:display.review.flags};
        for(const enabled of [true,false,true]) {
          await page.evaluate(value=>window.__s63.meeting.setRuntimeCrossChecksEnabled(value),enabled);
          await page.waitForFunction(value=>window.__s63.meeting.settings.runtimeCrossChecksEnabled===value,enabled);
          assert.deepEqual(await readDisplay(),{...display,crossChecks:enabled,stored:enabled});
        }
        await page.evaluate(()=>window.__s63.meeting.setPersonalEvidenceGuardrailMode('shadow'));
        await page.waitForFunction(()=>!document.querySelector('[data-fact-risk-review]'));
        await page.evaluate(()=>window.__s63.meeting.setPersonalEvidenceGuardrailMode('enforcement'));
        await page.getByText('Measurement needs verification.',{exact:true}).waitFor();
        assert.equal(await page.evaluate(()=>window.__s63.requests.filter(x=>x.factRiskReview).length),1);
        const requests=await page.evaluate(()=>window.__s63.requests.filter(x=>x.factRiskReview));
        assert.doesNotMatch(requests[0].user,/Original reasoning/);
        await page.evaluate(()=>window.__s63.meeting.stopRuntimeRegressionRun());
        assert.deepEqual(failures,[]);
        assert.deepEqual(await page.evaluate(()=>window.__s63.unexpected),[]);
      }finally{await context.close();}
    });
    // PC7: Normal and Focus show the same fact-risk result for the same answer.
    assert.deepEqual(Object.keys(displayedReviews),['S63-N1','S63-F1']);
    assert.deepEqual([displayedReviews['S63-N1'].surface,displayedReviews['S63-F1'].surface],['normal','focus']);
    assert.deepEqual({...displayedReviews['S63-F1'],surface:null},{...displayedReviews['S63-N1'],surface:null});
    assert.deepEqual(displayedReviews['S63-N1'].flags,[{section:'answer',quote:'40%',reason:'Measurement needs verification.',sourceIds:[]}]);
  }finally{await browser.close();}
});
