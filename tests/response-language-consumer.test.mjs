import assert from 'node:assert/strict';
import test from 'node:test';
import {browserBundle,openProjectSelectionBrowserHost,playwright,fixtures} from './project-selection-hook-browser.test.mjs';

test('NL5 existing settings affect the next request without rewriting the visible answer',{timeout:90000},async t=>{
  const bundle=await browserBundle();
  const browser=await playwright.chromium.launch({headless:true,executablePath:process.env.JARVIS_CHROMIUM_EXECUTABLE});
  try {
    for(const id of ['S63-N1','S63-F1'])await t.test(id,async child=>{
      const execution=fixtures.S63_CONSUMER_EXECUTIONS.find(x=>x.executionId===id);
      const {page,context,failures}=await openProjectSelectionBrowserHost(child,bundle,browser,execution);
      try {
        const before=await page.evaluate(()=>({content:window.__s63.observed.adviseDisplay.stable.suggestion.content,count:window.__s63.requests.length}));
        await page.evaluate(()=>window.__s63.meeting.setResponseConfig({length:'normal',language:'chinese'}));
        await page.waitForFunction(()=>window.__s63.meeting.settings.response.language==='chinese');
        assert.equal(await page.evaluate(()=>window.__s63.observed.adviseDisplay.stable.suggestion.content),before.content);
        assert.equal(await page.evaluate(()=>window.__s63.requests.length),before.count);
        await page.evaluate(()=>{window.__s63.stage='selected';window.__s63.failSelected=false;window.__s63.holdSelected=false;});
        await page.getByRole('button',{name:'Quartz Relay',exact:true}).click();
        await page.waitForFunction(()=>window.__s63.requests.some(x=>x.selectedFactPromptChecked));
        const request=await page.evaluate(()=>window.__s63.requests.find(x=>x.selectedFactPromptChecked));
        assert.match(request.user,/Natural language: chinese/);
        assert.match(request.user,/Use concise Chinese for all response prose/);
        await page.waitForFunction(()=>window.__s63.meeting.traces.some(t=>t.metadata?.clarifyingSelectionState==='succeeded'));
        assert.ok((await page.locator('[data-answer]').innerText()).length>0);
        await page.evaluate(()=>window.__s63.meeting.stopRuntimeRegressionRun());
        assert.deepEqual(failures,[]);
        assert.deepEqual(await page.evaluate(()=>window.__s63.unexpected),[]);
      }finally{await context.close();}
    });
  }finally{await browser.close();}
});
