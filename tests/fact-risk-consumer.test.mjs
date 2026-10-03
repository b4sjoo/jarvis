import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,readdirSync} from 'node:fs';
import {browserBundle,openProjectSelectionBrowserHost,playwright,browserTestSkip,fixtures} from './project-selection-hook-browser.test.mjs';

test('RG real publication, visible review, modes and delivery are separate',{timeout:90000,skip:browserTestSkip},async t=>{
  const bundle=await browserBundle();
  const browser=await playwright.chromium.launch({headless:true,executablePath:process.env.JARVIS_CHROMIUM_EXECUTABLE});
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
  }finally{await browser.close();}
});
