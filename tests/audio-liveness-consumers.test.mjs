import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import {build} from 'esbuild';

const parse=p=>ts.createSourceFile(p,readFileSync(p,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const main=parse('src/pages/app/components/meeting/index.tsx'), focus=parse('src/pages/app/components/meeting/focus-window.tsx');
function one(file,predicate){const found=[];const visit=n=>{if(predicate(n))found.push(n);ts.forEachChild(n,visit);};visit(file);assert.equal(found.length,1);return found[0];}
const init=name=>one(main,n=>ts.isVariableDeclaration(n)&&n.name.getText(main)===name).initializer.getText(main);
const warning=one(main,n=>ts.isPropertyAssignment(n)&&n.name.getText(main)==='audioInputWarning').initializer.getText(main);
const normal=one(main,n=>ts.isConditionalExpression(n)&&n.condition.getText(main)==='meeting.audioInputLiveness?.severity === "warning"'&&n.whenTrue.getText(main).includes('<section')).getText(main);
const embedded=one(main,n=>ts.isConditionalExpression(n)&&n.condition.getText(main)==='audioInputLiveness?.severity === "warning"').getText(main);
const badge=one(focus,n=>ts.isJsxElement(n)&&n.openingElement.tagName.getText(focus)==='Badge'&&n.openingElement.getText(focus).includes('snapshot.audioInputWarning')).getText(focus);
const fixtureFile=parse('tests/audio-input-liveness.test.ts');
const fixture=one(fixtureFile,n=>ts.isVariableDeclaration(n)&&n.name.getText(fixtureFile)==='FIXTURE').initializer.getText(fixtureFile);
const bundle=await build({stdin:{loader:'tsx',resolveDir:process.cwd(),contents:`
  import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
  import {ActivityIcon,AlertCircleIcon} from 'lucide-react';
  import {resolveAudioInputLivenessPresentation,authorizeNativeAudioLivenessEvent} from './src/lib/meeting/audio-input-liveness';
  import {EMPTY_MEETING_FOCUS_SNAPSHOT} from './src/lib/meeting/focus-window';
  import {createMeetingFocusDisplayModel} from './src/lib/meeting/focus-display';
  const cn=(...parts)=>parts.join(' '),WRAP_TEXT_CLASS='wrap';
  const Badge=({variant,children,...props})=><span {...props}>{children}</span>;
  export function render(state){
    const payload={...${fixture},state,candidateStartedAtMs:1000};
    const auth=authorizeNativeAudioLivenessEvent({payload,activeCaptureSessionId:'capture-1',activeCaptureGeneration:2,lastSnapshotSequence:0});
    if(!auth.authorized)throw Error(auth.reason);
    const audioInputLiveness=resolveAudioInputLivenessPresentation({captureActive:true,vadEnabled:true,latestEvent:auth.event,latestObservedAtMs:60000,nowMs:60000});
    const meeting={audioInputLiveness};
    const audioWarningLabel=${init('audioWarningLabel')};
    const audioWarningDetail=${init('audioWarningDetail')};
    const snapshot=createMeetingFocusDisplayModel({...EMPTY_MEETING_FOCUS_SNAPSHOT,statusLabel:'Listening',audioInputWarning:${warning}});
    return {state:audioInputLiveness.state,normal:renderToStaticMarkup(<>{${normal}}</>),embedded:renderToStaticMarkup(<>{${embedded}}</>),focus:renderToStaticMarkup(${badge})};
  }`},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',logLevel:'silent'});
const module={exports:{}};new Function('module','exports','require',bundle.outputFiles[0].text)(module,module.exports,createRequire(import.meta.url));
for(const state of ['segment-emitted','idle','signal-observed','segment-open','stalled']){
  test(`native ${state} reaches Normal, embedded Focus and serialized Focus warning consumers`,()=>{
    const actual=module.exports.render(state),warn=state==='segment-open'||state==='stalled';
    assert.equal(actual.state,warn?'stalled':state);
    assert.equal(actual.normal.includes('Speech not segmented'),warn);
    assert.equal(actual.embedded.includes('Speech candidate has remained open'),warn);
    assert.equal(actual.focus.includes('Speech not segmented'),warn);
    if(!warn){assert.equal(actual.normal,'');assert.equal(actual.embedded,'');assert.ok(actual.focus.includes('Listening'));}
  });
}
